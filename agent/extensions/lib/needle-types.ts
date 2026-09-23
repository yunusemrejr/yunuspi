/** Shared Needle3 types. Pure declarations: no I/O, no inference, no policy.
 * Needle is YunusPi's local semantic reflex (embeddings / ranking /
 * classification / bounded extraction). It never establishes truth,
 * authorization, completion, test success or permission. */

export type NeedleOp = "embed" | "rank" | "classify" | "extract";

export interface NeedleEmbedInput {
  texts: string[];
}

export interface NeedleEmbedResult {
  dim: number;
  /** One vector per input text, in order. Plain arrays (structured-clone safe). */
  vectors: number[][];
}

export interface NeedleRankCandidate {
  id: string;
  text: string;
}

export interface NeedleRankInput {
  query: string;
  candidates: NeedleRankCandidate[];
  /** Maximum ranked ids to return. Defaults to all candidates. */
  topK?: number;
}

export interface NeedleRanked {
  id: string;
  /** Cosine similarity in [-1, 1]. A ranking score, not a probability. */
  score: number;
}

export interface NeedleRankResult {
  ranked: NeedleRanked[];
  /** Score gap between rank 1 and rank 2 (0 when fewer than 2 candidates). */
  margin: number;
}

export interface NeedleClassifyInput {
  text: string;
  /** Labels as `id: description` candidates; nearest embedding wins. */
  labels: NeedleRankCandidate[];
  /** Minimum top-1 score to accept without escalation. Policy-owned default. */
  acceptAt?: number;
  /** Minimum margin to accept without escalation. Policy-owned default. */
  marginAt?: number;
}

export interface NeedleClassifyResult {
  label: string;
  score: number;
  margin: number;
  /** True when score/margin clear the acceptance floor. Escalation decisions
   * stay with the caller: helpers refine, they never gate authority. */
  accepted: boolean;
}

export interface NeedleExtractInput {
  text: string;
  /** JSON Schema (object) the grammar constrains decoding to. */
  schema: Record<string, unknown>;
  /** Short record name used as the extraction tool name. */
  name?: string;
  system?: string;
}

export interface NeedleExtractResult {
  /** Grammar-constrained JSON value produced by the engine. Callers must
   * still validate shape and ground fields in the source text. */
  value: unknown;
  /** Calibrated engine confidence in [0,1], or null when uncalibrated. */
  confidence: number | null;
}

export type NeedleHealthState =
  | "disabled"    // PI_NEEDLE=off or no usable backend
  | "warming"     // worker starting / weights loading
  | "healthy"     // ready and serving
  | "degraded"    // serving but a restart recently occurred
  | "unavailable" // assets missing/invalid or backend failed; harness unaffected
  | "cooling";    // restart budget exhausted; periodic re-probe pending

export interface NeedleHealth {
  state: NeedleHealthState;
  backend: string;
  /** Embedding dimension once known, else 0. */
  dim: number;
  /** Milliseconds since the worker became ready (0 when not ready). */
  uptimeMs: number;
  workerRestarts: number;
  lastError: string;
  queued: number;
  /** True when operating normally but results are shadow-only. */
  shadow: boolean;
}

export interface NeedleStats {
  calls: number;
  embedCalls: number;
  rankCalls: number;
  classifyCalls: number;
  extractCalls: number;
  /** Successful operations served entirely by cached embeddings, counted once per call. */
  cacheHits: number;
  /** Non-shadow successful operations; classifications must clear thresholds. */
  accepted: number;
  shadow: number;
  shadowAgreed?: number;
  shadowDisagreed?: number;
  escalatedToJev: number;
  escalatedToLlm: number;
  timeouts: number;
  workerRestarts: number;
  /** Observed latencies in ms (bounded ring for p50/p95). */
  latencies: number[];
  queueWaits: number[];
  skipReasons: Record<string, number>;
}

/** Backend interface: WASM today, native engine or another deployment later
 * without changing callers. All methods are synchronous engine calls run
 * inside the worker thread; the main thread never blocks on inference. */
export interface NeedleBackend {
  readonly name: string;
  /** Load weights/engine. Resolves to the embedding dimension. */
  init(assets: NeedleAssetPaths): Promise<number>;
  embed(texts: string[]): NeedleEmbedResult;
  /** Optional: backends without grammar decoding omit complete(). */
  complete?(input: string, toolsJson: string, system: string, maxTokens: number): { json: string; confidence: number | null };
  reset(): void;
  dispose(): void;
}

export interface NeedleAssetPaths {
  dir: string;
  loaderJs: string;
  wasm: string;
  weights: string;
  manifest: string;
}

/** Worker protocol (postMessage). Requests carry an id; exactly one response
 * (ok or error) is posted per request. */
export type NeedleWorkerRequest =
  | { id: number; op: "init"; assets: NeedleAssetPaths }
  | { id: number; op: "embed"; texts: string[] }
  | { id: number; op: "rank"; query: string; candidates: NeedleRankCandidate[]; topK: number }
  | { id: number; op: "classify"; text: string; labels: NeedleRankCandidate[]; acceptAt: number; marginAt: number }
  | { id: number; op: "extract"; text: string; name: string; schema: Record<string, unknown>; system: string }
  | { id: number; op: "complete"; input: string; toolsJson: string; system: string; maxTokens: number }
  | { id: number; op: "reset" }
  | { id: number; op: "ping" };

export type NeedleWorkerResponse =
  | { id: number; ok: true; result: unknown; ms: number; /** True only when embed/rank/classify performed no embedding forward pass. */ cached?: boolean }
  | { id: number; ok: false; error: string; ms: number };
