/** Micro-worker: a bounded remote role between Jev and a full subagent.
 *
 * Some tasks are too generative or contextual for a typed Jev judgment but
 * far too small for a full subagent (no tools, no exploration, no writes):
 * error-hypothesis generation, finding consolidation, concise briefs,
 * structured extraction, inspection-target proposals. The micro-worker
 * serves exactly those through cheap remote routes with hard budgets:
 *
 * - no recursive delegation, zero tools, no writes by default;
 * - small structured JSON outputs, validated before use;
 * - tight context/output/time/cost budgets per call;
 * - route eligibility over price, quality evidence, health AND provider
 *   privacy tier — "free" never implies safe for private repositories.
 *
 * Routes are never hardcoded as available. Candidates come from
 * PI_MICRO_WORKER_ROUTES (comma "provider/model" slugs) and qualify
 * against caller-supplied live facts plus the qualification lab's
 * expiring eligibility. Unknown quality stays unknown: without evidence
 * the worker abstains rather than guessing on a random cheap route.
 */
import { createHash } from "node:crypto";
import { microMetrics } from "./metrics.ts";
import { sessionObservability } from "../session-observability.ts";
import { beginHarnessActivity } from "../harness-activity.ts";
import { routePrivacyTier } from "./route-privacy.ts";

export const MICRO_WORKER_MAX_INPUT_CHARS = 8000;
export const MICRO_WORKER_MAX_OUTPUT_TOKENS = 1000;
export const MICRO_WORKER_TIMEOUT_MS = 60_000;
export const MICRO_WORKER_COST_CAP_USD = 0.005;
export const MICRO_WORKER_PRICE_CAP_PER_M_USD = 0.5;
export const MICRO_WORKER_CACHE_MAX = 64;
export const MICRO_WORKER_CACHE_TTL_MS = 10 * 60 * 1000;

export type MicroWorkerKind =
  | "error-hypothesis"
  | "finding-consolidation"
  | "handoff-brief"
  | "structured-extraction"
  | "inspection-targets"
  | "patch-compare"
  | "source-glance";

export interface MicroWorkerFacts {
  provider: string;
  model: string;
  /** Known prompt price USD per 1M tokens; undefined means unknown. */
  pricePerM?: number;
  /** Quality score 0..1 from benchmarks/qual-lab; undefined means unknown. */
  quality?: number;
  healthy: boolean;
  cooldownUntil?: number;
  /** True when the input may contain private repository content. */
  privateInput: boolean;
}

export interface MicroWorkerEligibility {
  eligible: boolean;
  reason: string;
}

const KIND_PROMPTS: Record<MicroWorkerKind, { instruction: string; schema: string }> = {
  "error-hypothesis": {
    instruction: "Propose up to 3 ranked hypotheses for this failure with the single most discriminating check for each.",
    schema: '{"hypotheses":[{"cause":"...","check":"...","confidence":0..1}]}',
  },
  "finding-consolidation": {
    instruction: "Merge semantically duplicate findings. Keep every distinct issue; merge only same-cause same-location pairs.",
    schema: '{"groups":[{"kept":"<id>","merged":["<id>"],"reason":"..."}],"singletons":["<id>"]}',
  },
  "handoff-brief": {
    instruction: "Write a concise handoff: goal, done, open, next step. No prose beyond the fields.",
    schema: '{"goal":"...","done":["..."],"open":["..."],"next":"..."}',
  },
  "structured-extraction": {
    instruction: "Extract the requested fields exactly. Quote values verbatim; use null when absent.",
    schema: '{"fields":{"<name>":"...|null"}}',
  },
  "inspection-targets": {
    instruction: "Propose up to 5 inspection targets (files/symbols/queries) ordered by likelihood. No conclusions.",
    schema: '{"targets":[{"target":"...","why":"..."}]}',
  },
  "patch-compare": {
    instruction: "Compare the two patches: same behavior, behavior change, or unrelated. Name the decisive hunk.",
    schema: '{"verdict":"same|changed|unrelated","decisive":"...","notes":"..."}',
  },
  "source-glance": {
    instruction: "Summarize what this small source excerpt does and flag anything suspicious. No edits proposed.",
    schema: '{"summary":"...","flags":["..."]}',
  },
};

function validOutput(kind: MicroWorkerKind, output: Record<string, unknown>): boolean {
  const text = (value: unknown) => typeof value === 'string' && value.length <= 8000;
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const list = (value: unknown, valid: (entry: any) => boolean, max = 32) => Array.isArray(value) && value.length <= max && value.every(valid);
  switch (kind) {
    case 'error-hypothesis': return list(output.hypotheses, entry => object(entry) && text(entry.cause) && text(entry.check)
      && typeof entry.confidence === 'number' && Number.isFinite(entry.confidence) && entry.confidence >= 0 && entry.confidence <= 1, 3);
    case 'finding-consolidation': return list(output.groups, entry => object(entry) && text(entry.kept) && list(entry.merged, text) && text(entry.reason)) && list(output.singletons, text);
    case 'handoff-brief': return text(output.goal) && list(output.done, text) && list(output.open, text) && text(output.next);
    case 'structured-extraction': return object(output.fields) && Object.keys(output.fields).length <= 64 && Object.values(output.fields).every(value => value === null || text(value));
    case 'inspection-targets': return list(output.targets, entry => object(entry) && text(entry.target) && text(entry.why), 5);
    case 'patch-compare': return ['same', 'changed', 'unrelated'].includes(String(output.verdict)) && text(output.decisive) && text(output.notes);
    case 'source-glance': return text(output.summary) && list(output.flags, text);
  }
}

export function microWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !["1", "true", "yes"].includes((env.PI_OFFLINE ?? "").toLowerCase())
    && !["off", "0"].includes((env.PI_MICRO_WORKER ?? "on").toLowerCase());
}

export function microWorkerCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.PI_MICRO_WORKER_ROUTES ?? "";
  const out: string[] = [];
  for (const entry of raw.split(",")) {
    const clean = entry.trim().replace(/\s+/g, "");
    if (!clean || clean.length > 160 || !clean.includes("/") || out.length >= 16) continue;
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

function noteHealth(kind: string, data: Record<string, unknown>): void {
  try {
    sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.(kind, data);
  } catch {
    /* Telemetry is optional. */
  }
}

/** Eligibility over price, quality evidence, health, and privacy tier. */
export function microWorkerEligibility(
  facts: MicroWorkerFacts,
  now = Date.now(),
  env: Record<string, string | undefined> = process.env,
): MicroWorkerEligibility {
  if (!facts.healthy) return { eligible: false, reason: "unhealthy" };
  if (facts.cooldownUntil !== undefined && now < facts.cooldownUntil) return { eligible: false, reason: "cooldown" };
  if (facts.privateInput && routePrivacyTier(facts.provider, facts.model, env).tier === "unknown") {
    return { eligible: false, reason: "private-input-unsafe-route" };
  }
  if (facts.pricePerM === undefined) return { eligible: false, reason: 'unknown-price' };
  if (!Number.isFinite(facts.pricePerM) || facts.pricePerM < 0) return { eligible: false, reason: 'invalid-price' };
  if (facts.pricePerM > MICRO_WORKER_PRICE_CAP_PER_M_USD) {
    return { eligible: false, reason: "over-price-cap" };
  }
  if (facts.quality === undefined) return { eligible: false, reason: 'unknown-quality' };
  if (!Number.isFinite(facts.quality) || facts.quality < 0 || facts.quality > 1) return { eligible: false, reason: 'invalid-quality' };
  if (facts.quality < 0.5) return { eligible: false, reason: "quality-floor" };
  return { eligible: true, reason: "eligible" };
}

export type MicroWorkerComplete = (input: {
  route: string;
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}) => Promise<{ text: string; inputTokens?: number; costUsd?: number; ms: number }>;

export interface MicroWorkerResult {
  ok: boolean;
  output?: Record<string, unknown>;
  route?: string;
  ms: number;
  cached: boolean;
  costUsd?: number;
  skipped?: string;
}

export interface MicroWorkerOptions {
  complete: MicroWorkerComplete | undefined;
  facts: MicroWorkerFacts | undefined;
  privateInput?: boolean;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  now?: () => number;
}

const workerCache = new Map<string, { output: Record<string, unknown>; route: string; costUsd?: number; at: number }>();

export function clearMicroWorkerCache(): void {
  workerCache.clear();
}

const cacheKey = (kind: string, input: string, route: string): string =>
  createHash("sha256").update(JSON.stringify([kind, input, route])).digest("hex");

export async function runMicroWorker(
  kind: MicroWorkerKind,
  input: string,
  opts: MicroWorkerOptions,
): Promise<MicroWorkerResult> {
  const metrics = microMetrics();
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const started = now();
  if (!microWorkerEnabled(env)) {
    metrics.skip("microworker", "disabled");
    return { ok: false, ms: 0, cached: false, skipped: "disabled" };
  }
  if (!Object.hasOwn(KIND_PROMPTS, kind)) {
    metrics.skip("microworker", "unknown-kind");
    return { ok: false, ms: 0, cached: false, skipped: "unknown-kind" };
  }
  if (typeof input !== "string" || input.trim().length < 8) {
    metrics.skip("microworker", "trivial");
    return { ok: false, ms: 0, cached: false, skipped: "trivial" };
  }
  if (opts.signal?.aborted) {
    metrics.skip("microworker", "aborted");
    return { ok: false, ms: 0, cached: false, skipped: "aborted" };
  }
  metrics.offer("microworker");
  if (!opts.complete || !opts.facts) {
    metrics.skip("microworker", "no-route");
    noteHealth("ml.microworker.skipped", { count: 1, reason: "no-route", op: kind });
    return { ok: false, ms: 0, cached: false, skipped: "no-route" };
  }
  const eligibility = microWorkerEligibility({ ...opts.facts, privateInput: opts.privateInput ?? opts.facts.privateInput ?? true }, now(), env);
  if (!eligibility.eligible) {
    metrics.skip("microworker", eligibility.reason);
    noteHealth("ml.microworker.skipped", { count: 1, reason: eligibility.reason, op: kind });
    return { ok: false, ms: 0, cached: false, skipped: eligibility.reason };
  }
  const route = `${opts.facts.provider}/${opts.facts.model}`;
  const bounded = input.slice(0, MICRO_WORKER_MAX_INPUT_CHARS);
  const key = cacheKey(kind, bounded, route);
  const cached = workerCache.get(key);
  if (cached && now() - cached.at < MICRO_WORKER_CACHE_TTL_MS) {
    metrics.run("microworker", 0, bounded.length);
    metrics.cacheHit("microworker");
    noteHealth("ml.microworker.used", { count: 1, cached: true, op: kind });
    return { ok: true, output: structuredClone(cached.output), route: cached.route, costUsd: 0, ms: 0, cached: true };
  }
  const finish = beginHarnessActivity("microworker");
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.min(MICRO_WORKER_TIMEOUT_MS, opts.timeoutMs!)) : MICRO_WORKER_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new DOMException('Micro-worker timeout', 'TimeoutError')), timeoutMs);
  let onAbort!: () => void, succeeded = false;
  const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const spec = KIND_PROMPTS[kind];
    const answer = await Promise.race([opts.complete({
      route,
      system: `${spec.instruction} Reply with JSON only matching ${spec.schema}. No tools, no delegation, no file writes.`,
      user: bounded,
      maxTokens: MICRO_WORKER_MAX_OUTPUT_TOKENS,
      signal,
    }), interrupted]);
    signal.throwIfAborted();
    const ms = Math.max(0, now() - started);
    if ((answer.costUsd ?? 0) > MICRO_WORKER_COST_CAP_USD) {
      metrics.skip("microworker", "over-cost-cap");
      noteHealth("ml.microworker.skipped", { count: 1, reason: "over-cost-cap", op: kind, durationMs: ms });
      return { ok: false, ms, cached: false, skipped: "over-cost-cap" };
    }
    let output: Record<string, unknown>;
    try {
      if (typeof answer.text !== 'string' || answer.text.length > 16_384) throw Error('oversized output');
      const parsed: unknown = JSON.parse(answer.text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("not an object");
      output = parsed as Record<string, unknown>;
      if (!validOutput(kind, output)) throw Error('invalid output shape');
    } catch {
      metrics.skip("microworker", "malformed");
      noteHealth("ml.microworker.skipped", { count: 1, reason: "malformed", op: kind, durationMs: ms });
      return { ok: false, ms, cached: false, skipped: "malformed" };
    }
    metrics.run("microworker", ms, bounded.length);
    metrics.accept("microworker");
    if (workerCache.size >= MICRO_WORKER_CACHE_MAX) workerCache.delete(workerCache.keys().next().value!);
    workerCache.set(key, { output: structuredClone(output), route, costUsd: answer.costUsd, at: now() });
    noteHealth("ml.microworker.used", { count: 1, cached: false, op: kind, durationMs: ms, route });
    succeeded = true;
    return { ok: true, output, route, costUsd: answer.costUsd, ms, cached: false };
  } catch (error) {
    const ms = Math.max(0, now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const reason = opts.signal?.aborted ? 'aborted' : controller.signal.aborted || /timeout/i.test(message) ? "timeout" : "unavailable";
    metrics.skip("microworker", reason);
    noteHealth("ml.microworker.skipped", { count: 1, reason, op: kind, durationMs: ms });
    return { ok: false, ms, cached: false, skipped: reason };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort);
    try { finish(succeeded ? 'ok' : opts.signal?.aborted ? 'cancelled' : 'error'); } catch { /* display only */ }
  }
}

export function microWorkerStatus(env: Record<string, string | undefined> = process.env): {
  enabled: boolean;
  candidates: string[];
  cacheEntries: number;
} {
  return { enabled: microWorkerEnabled(env), candidates: microWorkerCandidates(env), cacheEntries: workerCache.size };
}
