import { sessionObservability } from './session-observability.ts';
/** Needle runtime: one long-lived worker thread per process, bounded queue,
 * caches, timeouts, health state, crash recovery and graceful degradation.
 * No failure here may break normal YunusPi operation: every op resolves to
 * either a validated value or a skip reason the caller already handles.
 */
import { Worker } from "node:worker_threads";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { beginHarnessActivity } from "./harness-activity.ts";
import type {
  NeedleClassifyInput,
  NeedleClassifyResult,
  NeedleEmbedResult,
  NeedleExtractInput,
  NeedleExtractResult,
  NeedleHealth,
  NeedleHealthState,
  NeedleRankCandidate,
  NeedleRankInput,
  NeedleRankResult,
  NeedleStats,
  NeedleWorkerRequest,
  NeedleWorkerResponse,
} from "./needle-types.ts";
import { needlePolicy, needleText, needleHash, type NeedlePolicy, type NeedleSkipReason } from "./needle-policy.ts";
import { NEEDLE_MANIFEST_VERSION, NEEDLE_PINNED_FILES, NEEDLE_REVISION } from "./needle-assets.mjs";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");
const SHARED_RUNTIME = Symbol.for("yunus-pi.needle-runtime.v1");
const processState = globalThis as typeof globalThis & { [SHARED_RUNTIME]?: NeedleHandle };

function noteHealth(kind: string, data: Record<string, unknown>): void {
  try { sessionObservability()[HEALTH_SINK]?.(kind, data); } catch { /* telemetry is optional */ }
}

export const NEEDLE_ASSET_FILES = ["needle.js", "needle.wasm", "needle3.cact"] as const;

export function needleAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function needleAssetDir(): string {
  return process.env.PI_NEEDLE_ASSETS || join(needleAgentDir(), "local-models", "needle3");
}

export type NeedleResult<T> =
  | { ok: true; value: T; cached: boolean; ms: number; shadow: boolean }
  | { ok: false; reason: NeedleSkipReason; detail?: string };

const RING_MAX = 128;

function percentile(sorted: number[], frac: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))];
}

export function needleLatencySummary(latencies: number[]): { p50: number; p95: number; count: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), count: sorted.length };
}

type WorkerFactory = (script: URL, options: { workerData: unknown; execArgv: string[] }) => {
  on(event: string, listener: (...args: never[]) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<unknown>;
  unref?(): void;
};

type Pending = {
  resolve: (response: NeedleWorkerResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  op: string;
  queuedAt: number;
};

export interface NeedleHandle {
  warmup(): void;
  embed(texts: string[]): Promise<NeedleResult<NeedleEmbedResult>>;
  rank(input: NeedleRankInput): Promise<NeedleResult<NeedleRankResult>>;
  classify(input: NeedleClassifyInput): Promise<NeedleResult<NeedleClassifyResult>>;
  extract(input: NeedleExtractInput): Promise<NeedleResult<NeedleExtractResult>>;
  health(): NeedleHealth;
  stats(): NeedleStats & { p50: number; p95: number };
  noteEscalation(kind: "jev" | "llm"): void;
  noteShadowAgreement(agreed: boolean): void;
  shutdown(): Promise<void>;
}

export function createNeedleRuntime(options: {
  policy?: NeedlePolicy;
  workerFactory?: WorkerFactory;
  now?: () => number;
  assetDir?: string;
} = {}): NeedleHandle {
  const policy = options.policy ?? needlePolicy();
  const now = options.now ?? Date.now;
  const assets = options.assetDir ?? needleAssetDir();
  // The worker is plain JS + WASM: it never needs host flags, and inheriting
  // them breaks the respawn (e.g. --input-type/--test leak into execArgv).
  const spawnWorker: WorkerFactory = options.workerFactory ?? ((script, opts) =>
    new Worker(script, { workerData: opts.workerData, execArgv: [] }) as unknown as ReturnType<WorkerFactory>);

  let state: NeedleHealthState = policy.enabled ? "warming" : "disabled";
  let starting = false;
  let closed = false;
  let active = false;
  let worker: ReturnType<WorkerFactory> | undefined;
  let nextId = 1;
  let ready = false;
  let dim = 0;
  let readyAt = 0;
  let lastError = "";
  let restarts = 0;
  let restartMarks: number[] = [];
  let coolingUntil = 0;
  let reprobeTimer: ReturnType<typeof setTimeout> | undefined;
  let degraded = false;

  const pending = new Map<number, Pending>();
  const queue: Array<{ request: Omit<NeedleWorkerRequest, "id">; op: string; queuedAt: number; resolve: (r: NeedleResult<never>) => void; timer: ReturnType<typeof setTimeout> }> = [];
  const embedCache = new Map<string, number[]>();
  const stats: NeedleStats = {
    calls: 0, embedCalls: 0, rankCalls: 0, classifyCalls: 0, extractCalls: 0,
    cacheHits: 0, accepted: 0, shadow: 0, escalatedToJev: 0, escalatedToLlm: 0,
    timeouts: 0, workerRestarts: 0, latencies: [], queueWaits: [], skipReasons: {},
  };
  let shadowAgreed = 0, shadowDisagreed = 0;

  const skip = (reason: NeedleSkipReason, detail?: string): NeedleResult<never> => {
    stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1;
    return { ok: false, reason, ...(detail ? { detail } : {}) };
  };

  const pushLatency = (ring: number[], ms: number): void => {
    ring.push(ms);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  };

  const assetPaths = () => ({
    dir: assets,
    loaderJs: join(assets, "needle.js"),
    wasm: join(assets, "needle.wasm"),
    weights: join(assets, "needle3.cact"),
    manifest: join(assets, "manifest.json"),
  });

  /** Match the worker's cheap integrity gate before spawning a thread. Full
   * hashes still run inside the worker, but a missing/mismatched manifest or
   * truncated asset must not consume a worker restart before that check. */
  const assetPreflight = (): string | undefined => {
    try {
      const manifest = JSON.parse(readFileSync(join(assets, "manifest.json"), "utf8")) as { version?: unknown; revision?: unknown };
      if (!manifest || manifest.version !== NEEDLE_MANIFEST_VERSION || manifest.revision !== NEEDLE_REVISION)
        return `asset integrity failed: manifest version/revision does not match pinned ${NEEDLE_REVISION}`;
      for (const file of NEEDLE_PINNED_FILES) {
        const info = statSync(join(assets, file.local));
        if (!info.isFile()) return `asset integrity failed: ${file.local} is not a regular file`;
        if (info.size !== file.bytes) return `asset integrity failed: ${file.local} size ${info.size} != pinned ${file.bytes}`;
      }
      return undefined;
    } catch {
      return "asset integrity failed: manifest or pinned asset is missing/unreadable";
    }
  };

  const setState = (next: NeedleHealthState, error = ""): void => {
    state = next;
    if (error) lastError = error.slice(0, 240);
    noteHealth("ml.needle.state", { state: next, count: 1 });
  };

  const failAll = (reason: NeedleSkipReason, detail?: string): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id: -1, ok: false, error: `${reason}${detail ? `: ${detail}` : ""}`, ms: 0 });
    }
    pending.clear();
    while (queue.length) {
      const item = queue.shift();
      if (item) { clearTimeout(item.timer); item.resolve(skip(reason, detail)); }
    }
  };

  const scheduleReprobe = (): void => {
    if (reprobeTimer || !policy.enabled || closed) return;
    const wait = state === "cooling"
      ? Math.max(0, coolingUntil - now())
      : policy.reprobeMs;
    reprobeTimer = setTimeout(() => {
      reprobeTimer = undefined;
      if (state === "cooling" && now() < coolingUntil) {
        scheduleReprobe();
        return;
      }
      const preflightError = assetPreflight();
      if (!preflightError) {
        degraded = restarts > 0;
        startWorker();
      } else {
        setState("unavailable", preflightError);
        scheduleReprobe();
      }
    }, Math.min(Math.max(1000, wait), policy.cooldownMs));
    reprobeTimer.unref?.();
  };

  const onWorkerDown = (why: string, instance?: unknown): void => {
    // Idempotent per worker instance: a synchronous exit emission during
    // terminate() must not double-count one wedge as two crashes.
    if (instance !== undefined && worker !== instance) return;
    starting = false;
    const previous = worker;
    const hadWorker = previous !== undefined;
    worker = undefined;
    // Detach before termination: the resulting exit belongs to the old worker.
    void previous?.terminate().catch(() => {});
    embedCache.clear();
    ready = false;
    dim = 0;
    failAll("unavailable", why);
    if (!policy.enabled || closed) {
      setState(closed ? "unavailable" : "disabled");
      return;
    }
    restartMarks = restartMarks.filter((mark) => now() - mark < policy.restartWindowMs);
    if (restartMarks.length >= policy.maxRestarts) {
      coolingUntil = now() + policy.cooldownMs;
      setState("cooling", `restart budget exhausted (${why})`);
      noteHealth("ml.needle.restart", { decision: "cooling", count: 1 });
      scheduleReprobe();
      return;
    }
    restartMarks.push(now());
    if (hadWorker) {
      restarts++;
      stats.workerRestarts++;
      noteHealth("ml.needle.restart", { decision: "restart", count: 1 });
    }
    degraded = restarts > 0;
    startWorker();
  };

  const startWorker = (): void => {
    if (!policy.enabled || closed || worker || starting) return;
    const preflightError = assetPreflight();
    if (preflightError) {
      setState("unavailable", `${preflightError} in ${assets}`);
      scheduleReprobe();
      return;
    }
    setState("warming");
    starting = true;
    let instance: ReturnType<WorkerFactory>;
    try {
      const script = new URL("./needle-worker.mjs", import.meta.url);
      instance = spawnWorker(script, { workerData: { cacheMax: policy.workerCacheMax }, execArgv: [] });
    } catch (error) {
      starting = false;
      setState("unavailable", error instanceof Error ? error.message : String(error));
      scheduleReprobe();
      return;
    }
    worker = instance;
    instance.on("message", (message) => {
      if (worker !== instance) return;
      const response = message as NeedleWorkerResponse;
      if (response?.id === -1) return; // worker hello
      const entry = pending.get(response?.id);
      if (!entry) return;
      pending.delete(response.id);
      clearTimeout(entry.timer);
      entry.resolve(response);
    });
    const down = (error: unknown): void => {
      onWorkerDown(error instanceof Error ? error.message : String(error), instance);
    };
    instance.on("error", down);
    instance.on("exit", (code: unknown) => {
      onWorkerDown(`worker exited (${String(code)})`, instance);
    });
    // An idle semantic helper must not retain a CLI or test host. Awaited
    // dispatch/queue timers stay referenced while work is required.
    instance.unref?.();
    // Init handshake runs as a normal op so timeouts apply uniformly.
    dispatch({ op: "init", assets: assetPaths() }, "init").then(
      (response) => {
        if (worker !== instance) return;
        if (!response.ok) {
          onWorkerDown(typeof response.error === "string" ? response.error : "init failed", instance);
          return;
        }
        const value = response.result as { dim?: number } | undefined;
        if (!value || !Number.isInteger(value.dim) || value.dim <= 0 || value.dim > 8192) {
          onWorkerDown("init returned no dimension", instance);
          return;
        }
        dim = value.dim;
        ready = true;
        readyAt = now();
        starting = false;
        setState(degraded ? "degraded" : "healthy");
        noteHealth("ml.needle.ready", { dim, count: 1 });
        drain();
      },
      () => { onWorkerDown("init failed", instance); },
    );
  };

  /** Input-scaled op budget: embed latency is ~3.5ms/char warm, so long
   * batches get headroom up to the ceiling instead of a fixed 1.5s. */
  const budgetFor = (request: Omit<NeedleWorkerRequest, "id">, op: string): number => {
    if (op === "init") return Math.max(policy.opTimeoutMs, 30_000);
    // Grammar decoding is substantially slower than embeddings; its output
    // work is not predicted by input characters alone. Keep the hard ceiling.
    if (op === "extract" || op === "complete") return policy.maxOpTimeoutMs;
    let chars = 0;
    const add = (value: unknown): void => {
      if (typeof value === "string") chars += value.length;
    };
    const addList = (value: unknown): void => {
      if (Array.isArray(value)) for (const entry of value) add((entry as { text?: unknown })?.text ?? entry);
    };
    const req = request as Record<string, unknown>;
    add(req.query);
    add(req.text);
    add(req.input);
    addList(req.texts);
    addList(req.candidates);
    addList(req.labels);
    if (req.schema !== undefined) chars += JSON.stringify(req.schema)?.length ?? 0;
    add(req.toolsJson);
    return Math.min(policy.maxOpTimeoutMs, Math.max(policy.opTimeoutMs, 400 + Math.ceil(chars * 5)));
  };

  const dispatch = (request: Omit<NeedleWorkerRequest, "id">, op: string): Promise<NeedleWorkerResponse> =>
    new Promise((settle) => {
      const id = nextId++;
      const current = worker;
      if (!current) {
        settle({ id, ok: false, error: "unavailable: no worker", ms: 0 });
        return;
      }
      const finish = beginHarnessActivity('needle');
      const resolve = (response: NeedleWorkerResponse) => { finish(response.ok ? 'ok' : closed ? 'cancelled' : 'error'); settle(response); };
      const budget = budgetFor(request, op);
      const timer = setTimeout(() => {
        pending.delete(id);
        stats.timeouts++;
        noteHealth("ml.needle.timeout", { op, count: 1 });
        resolve({ id, ok: false, error: "timeout", ms: budget });
        // A synchronous WASM call cannot be cancelled. Drop this worker so
        // stale work cannot consume the next operation's execution budget.
        if (worker === current) onWorkerDown(`${op} timed out`, current);
      }, budget);
      // Ref'd: this timer guards an awaited promise. Only fire-and-forget
      // timers (reprobe/cooldown) may unref.
      pending.set(id, { resolve, timer, op, queuedAt: now() });
      try {
        current.postMessage({ ...request, id });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ id, ok: false, error: error instanceof Error ? error.message : String(error), ms: 0 });
      }
    });

  const drain = (): void => {
    if (!ready || !worker || active || !queue.length) return;
    const item = queue.shift()!;
    clearTimeout(item.timer);
    pushLatency(stats.queueWaits, now() - item.queuedAt);
    active = true;
    void runOp(item.request, item.op).then(item.resolve).finally(() => {
      active = false;
      drain();
    });
  };

  const enqueue = (request: Omit<NeedleWorkerRequest, "id">, op: string): Promise<NeedleResult<never>> =>
    new Promise((resolve) => {
      if (queue.length >= policy.maxQueue) {
        resolve(skip("busy"));
        return;
      }
      // Queue deadlines prevent speculative work from becoming unbounded
      // latency. Only dispatched work spends an inference timeout/restart.
      const item = { request, op, queuedAt: now(), resolve, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      item.timer = setTimeout(() => {
        const index = queue.indexOf(item);
        if (index < 0) return;
        queue.splice(index, 1);
        pushLatency(stats.queueWaits, now() - item.queuedAt);
        resolve(skip("busy", "queue deadline exceeded"));
      }, policy.maxOpTimeoutMs);
      queue.push(item);
      drain();
    });

  const runOp = async (request: Omit<NeedleWorkerRequest, "id">, op: string): Promise<NeedleResult<never>> => {
    const started = now();
    const response = await dispatch(request, op);
    const ms = now() - started;
    pushLatency(stats.latencies, ms);
    if (!response.ok) {
      const error = typeof response.error === "string" ? response.error : "malformed worker response";
      const reason: NeedleSkipReason = error === "timeout" ? "timeout" : "unavailable";
      stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1;
      return { ok: false, reason, detail: error.slice(0, 160) };
    }
    stats.calls++;
    if (policy.shadow) stats.shadow++;
    return { ok: true, value: response.result as never, cached: false, ms, shadow: policy.shadow };
  };

  const call = (request: Omit<NeedleWorkerRequest, "id">, op: string): Promise<NeedleResult<never>> => {
    if (closed) return Promise.resolve(skip("unavailable", "shutdown"));
    if (!policy.enabled) return Promise.resolve(skip("disabled"));
    if (state === "cooling") return Promise.resolve(skip("cooldown", lastError));
    if (!ready || !worker) {
      // Cold callers trigger warmup: an op must never hang on a worker
      // that was never started. Missing assets skip immediately.
      if (!starting) startWorker();
      if (!worker) return Promise.resolve(skip(state === "cooling" ? "cooldown" : "unavailable"));
      return enqueue(request, op);
    }
    return enqueue(request, op);
  };

  const finished = <T>(result: NeedleResult<never>, counter: "embedCalls" | "rankCalls" | "classifyCalls" | "extractCalls"): NeedleResult<T> => {
    if (result.ok) {
      stats[counter]++;
      if (!result.shadow && (counter !== "classifyCalls" || (result.value as NeedleClassifyResult).accepted)) stats.accepted++;
      noteHealth("ml.needle.call", { op: counter.replace("Calls", ""), cached: result.cached, shadow: result.shadow, durationMs: result.ms, count: 1 });
      return result as NeedleResult<T>;
    }
    return result as NeedleResult<T>;
  };

  const handle: NeedleHandle = {
    warmup() {
      if (!closed && policy.enabled && !worker && !starting && state !== "cooling") startWorker();
    },
    async embed(texts) {
      if (closed) return skip("unavailable", "shutdown");
      if (!policy.enabled) return skip("disabled");
      if (!Array.isArray(texts) || !texts.length) return skip("trivial");
      if (texts.length > policy.maxBatch) return skip("too-large", `batch of ${texts.length}`);
      const cleaned: string[] = [];
      for (const raw of texts) {
        const text = needleText(raw, policy.maxTextChars);
        if (!text) return skip("unsupported-shape");
        cleaned.push(text);
      }
      const keys = cleaned.map(needleHash);
      const vectors: number[][] = new Array(cleaned.length);
      const missing: string[] = [];
      const missingIdx: number[] = [];
      if (policy.embedCacheMax > 0) {
        cleaned.forEach((text, index) => {
          const hit = embedCache.get(keys[index]);
          if (hit) {
            vectors[index] = [...hit];
            embedCache.delete(keys[index]);
            embedCache.set(keys[index], hit);
          } else {
            missing.push(text);
            missingIdx.push(index);
          }
        });
        if (!missing.length) {
          beginHarnessActivity('needle')('cached');
          stats.cacheHits++;
          stats.calls++;
          if (policy.shadow) stats.shadow++;
          return finished<NeedleEmbedResult>({ ok: true, value: { dim, vectors }, cached: true, ms: 0, shadow: policy.shadow }, "embedCalls");
        }
      } else {
        missing.push(...cleaned);
        missingIdx.push(...cleaned.map((_, index) => index));
      }
      const result = await call({ op: "embed", texts: missing }, "embed");
      if (!result.ok) return result as NeedleResult<NeedleEmbedResult>;
      const value = result.value as NeedleEmbedResult;
      if (!value || value.dim !== dim || !Array.isArray(value.vectors) || value.vectors.length !== missing.length
        || value.vectors.some((vector) => !Array.isArray(vector) || vector.length !== dim || !vector.every(Number.isFinite) || !vector.some((v) => v !== 0))) {
        return skip("unavailable", "malformed embed result");
      }
      value.vectors.forEach((vector, i) => {
        vectors[missingIdx[i]] = vector;
        if (policy.embedCacheMax > 0) {
          embedCache.delete(keys[missingIdx[i]]);
          embedCache.set(keys[missingIdx[i]], [...vector]);
          if (embedCache.size > policy.embedCacheMax) embedCache.delete(embedCache.keys().next().value!);
        }
      });
      return finished<NeedleEmbedResult>({ ok: true, value: { dim, vectors }, cached: false, ms: result.ms, shadow: result.shadow }, "embedCalls");
    },
    async rank(input) {
      const query = needleText(input?.query, policy.maxTextChars);
      const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
      if (!query || !candidates.length) return skip("trivial");
      if (candidates.length > policy.maxBatch * 4) return skip("too-large", `${candidates.length} candidates`);
      const cleaned: NeedleRankCandidate[] = [];
      const ids = new Set<string>();
      for (const candidate of candidates.slice(0, policy.maxBatch * 4)) {
        const text = needleText(candidate?.text, policy.maxTextChars);
        const id = typeof candidate?.id === "string" && candidate.id.length <= 256 ? candidate.id : "";
        if (!id || !text || ids.has(id)) return skip("unsupported-shape", "invalid or duplicate candidate");
        ids.add(id);
        cleaned.push({ id, text });
      }
      if (!cleaned.length) return skip("no-candidates");
      const topK = Number.isSafeInteger(input?.topK) && (input.topK as number) > 0
        ? Math.min(input.topK as number, cleaned.length)
        : cleaned.length;
      const result = await call({ op: "rank", query, candidates: cleaned, topK }, "rank");
      if (!result.ok) return result as NeedleResult<NeedleRankResult>;
      const value = result.value as NeedleRankResult;
      const seen = new Set<string>();
      if (!value || !Array.isArray(value.ranked) || value.ranked.length !== topK
        || !Number.isFinite(value.margin) || value.margin < 0 || value.margin > 2
        || value.ranked.some((entry, i) => {
          if (!entry || !ids.has(entry.id) || seen.has(entry.id) || !Number.isFinite(entry.score)
            || entry.score < -1 || entry.score > 1 || (i > 0 && entry.score > value.ranked[i - 1].score)) return true;
          seen.add(entry.id);
          return false;
        })) return skip("unavailable", "malformed rank result");
      return finished<NeedleRankResult>(result as NeedleResult<NeedleRankResult>, "rankCalls");
    },
    async classify(input: NeedleClassifyInput) {
      const text = needleText(input?.text, policy.maxTextChars);
      const labels = Array.isArray(input?.labels) ? input.labels : [];
      if (!text || labels.length < 2) return skip("trivial");
      if (labels.length > policy.maxBatch) return skip("too-large", `${labels.length} labels`);
      const cleaned: NeedleRankCandidate[] = [];
      const ids = new Set<string>();
      for (const label of labels) {
        const body = needleText(label?.text, policy.maxTextChars);
        const id = typeof label?.id === "string" && label.id.length <= 256 ? label.id : "";
        if (!id || !body || ids.has(id)) return skip("unsupported-shape", "invalid or duplicate label");
        ids.add(id);
        cleaned.push({ id, text: body });
      }
      if (cleaned.length < 2) return skip("no-candidates");
      const acceptAt = typeof input?.acceptAt === "number" ? input.acceptAt : policy.acceptScore;
      const marginAt = typeof input?.marginAt === "number" ? input.marginAt : policy.acceptMargin;
      if (!Number.isFinite(acceptAt) || acceptAt < -1 || acceptAt > 1 || !Number.isFinite(marginAt) || marginAt < 0 || marginAt > 2) return skip("unsupported-shape", "invalid thresholds");
      const result = await call({ op: "classify", text, labels: cleaned, acceptAt, marginAt }, "classify");
      if (!result.ok) return result as NeedleResult<NeedleClassifyResult>;
      const value = result.value as NeedleClassifyResult;
      if (!value || !ids.has(value.label) || !Number.isFinite(value.score) || value.score < -1 || value.score > 1
        || !Number.isFinite(value.margin) || value.margin < 0 || value.margin > 2) return skip("unavailable", "malformed classify result");
      value.accepted = value.score >= acceptAt && value.margin >= marginAt;
      if (!value.accepted) {
        const reason = value.score < acceptAt ? "low-confidence" : "low-margin";
        stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1;
      }
      return finished<NeedleClassifyResult>({ ...(result as NeedleResult<NeedleClassifyResult>), value }, "classifyCalls");
    },
    async extract(input: NeedleExtractInput) {
      const text = needleText(input?.text, policy.maxTextChars);
      if (!text || !input?.schema || (typeof input.schema !== "object" || Array.isArray(input.schema))) return skip("trivial");
      let schemaSize = 0;
      try {
        schemaSize = JSON.stringify(input.schema).length;
      } catch {
        return skip("unsupported-shape");
      }
      if (schemaSize > 8192) return skip("too-large", "schema");
      const name = typeof input?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.name) ? input.name : "record";
      const system = typeof input?.system === "string" ? input.system.slice(0, 2048) : "";
      const result = await call({ op: "extract", text, name, schema: input.schema, system }, "extract");
      if (!result.ok) return result as NeedleResult<NeedleExtractResult>;
      const value = result.value as { value?: unknown; confidence?: number | null; refused?: boolean };
      if (!value || typeof value !== "object" || value.refused === true || value.value == null) {
        return skip("low-confidence", "needle refused extraction");
      }
      return finished<NeedleExtractResult>(
        { ...(result as NeedleResult<NeedleExtractResult>), value: { value: value.value, confidence: value.confidence ?? null } },
        "extractCalls",
      );
    },
    health(): NeedleHealth {
      return {
        state, backend: "wasm", dim,
        uptimeMs: ready ? Math.max(0, now() - readyAt) : 0,
        workerRestarts: restarts, lastError,
        queued: queue.length + pending.size,
        shadow: policy.shadow,
      };
    },
    stats() {
      const { p50, p95 } = needleLatencySummary(stats.latencies);
      return { ...stats, shadowAgreed, shadowDisagreed, latencies: [...stats.latencies], queueWaits: [...stats.queueWaits], skipReasons: { ...stats.skipReasons }, p50, p95 };
    },
    noteEscalation(kind) {
      if (kind === "jev") stats.escalatedToJev++;
      else stats.escalatedToLlm++;
    },
    noteShadowAgreement(agreed) {
      if (agreed) shadowAgreed++;
      else shadowDisagreed++;
      noteHealth("ml.needle.shadow", { decision: agreed ? "agree" : "disagree", count: 1 });
    },
    async shutdown() {
      closed = true;
      if (processState[SHARED_RUNTIME] === handle) delete processState[SHARED_RUNTIME];
      embedCache.clear();
      if (reprobeTimer) clearTimeout(reprobeTimer);
      reprobeTimer = undefined;
      failAll("unavailable", "shutdown");
      const current = worker;
      worker = undefined;
      ready = false;
      starting = false;
      if (current) await current.terminate().catch(() => {});
      if (policy.enabled) setState("unavailable", "shutdown");
    },
  };
  return handle;
}

/** The extension loader isolates modules, so the worker/queue/cache owner must
 * live on the process bridge. Warmup remains asynchronous and fail-open. */

export function needleHandle(): NeedleHandle {
  return processState[SHARED_RUNTIME] ??= createNeedleRuntime();
}

/** Test seam: drop the shared handle so the next caller builds a fresh one. */
export function resetNeedleForTests(): void {
  void processState[SHARED_RUNTIME]?.shutdown().catch(() => {});
}

export async function needleEmbed(texts: string[]): Promise<NeedleResult<NeedleEmbedResult>> {
  return needleHandle().embed(texts);
}

export async function needleRank(input: NeedleRankInput): Promise<NeedleResult<NeedleRankResult>> {
  return needleHandle().rank(input);
}

export async function needleClassify(input: NeedleClassifyInput): Promise<NeedleResult<NeedleClassifyResult>> {
  return needleHandle().classify(input);
}

export async function needleExtract(input: NeedleExtractInput): Promise<NeedleResult<NeedleExtractResult>> {
  return needleHandle().extract(input);
}

export function needleHealth(): NeedleHealth {
  return needleHandle().health();
}

export function needleWarmup(): void {
  needleHandle().warmup();
}
