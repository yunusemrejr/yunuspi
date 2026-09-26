/** Span behavior sensor: a soft semantic signal over recent session traces.
 *
 * Span scores a fixed behavior catalog against a bounded trace of recent
 * session events (tool calls/results, errors, edits, reviews, delegations,
 * completion attempts). Each signal resolves to present/absent/not-observable
 * probabilities. The sensor is advisory only:
 *
 * - It never mutates, blocks, or settles anything on its own.
 * - Scores reach Guardian, Observer, Watchmaker, quality and recovery logic
 *   only through `spanAdvisory`, which requires a calibrated present
 *   probability AND deterministic corroborating evidence for anything
 *   stronger than a shadow record.
 * - It starts in shadow mode (PI_SPAN_SHADOW=1 default): evaluations are
 *   recorded, measured and benchmarked, but no consumer may act on them.
 *
 * Transport is an injected scorer. The default OpenRouter scorer resolves
 * the configured Span slugs; unknown/unlisted slugs degrade to
 * "route-unavailable" instead of inventing a model identity. Every paid
 * call is ledgered as a `span-usage-v1` session entry (same contract as
 * `jev-usage-v1`) so cost and metrics treat Span like any other route.
 */
import { raceWithAbortSignal } from "@yunuspi/ai/utils/abort";
import { createHash } from "node:crypto";
import { microMetrics } from "./metrics.ts";
import { sessionObservability } from "../session-observability.ts";
import { beginHarnessActivity } from "../harness-activity.ts";
import { openRouterKey } from "../jev-client.ts";

export const SPAN_USAGE_ENTRY = "span-usage-v1";
export const SPAN_DEFAULT_MODEL = "respan/span-01-lite";
export const SPAN_DEFAULT_FALLBACK = "respan/span-01";
export const SPAN_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const SPAN_REQUEST_TIMEOUT_MS = 20_000;
export const SPAN_MAX_TRACE_EVENTS = 48;
export const SPAN_MAX_EVENT_CHARS = 400;
export const SPAN_MAX_INPUT_CHARS = 12_000;
export const SPAN_CACHE_MAX = 128;
export const SPAN_CACHE_TTL_MS = 10 * 60 * 1000;
/** Minimum P(present) before a signal is even eligible for advisory use. */
export const SPAN_ADVISE_THRESHOLD = 0.8;
/** Below this P(present) the signal is recorded as not detected. */
export const SPAN_ABSENT_THRESHOLD = 0.5;

export interface SpanSignal {
  id: string;
  label: string;
  description: string;
}

/** Fixed central behavior catalog. Ids are stable calibration keys. */
export const SPAN_CATALOG: readonly SpanSignal[] = [
  { id: "repeated-failure-loop", label: "Repeated failure loop", description: "Same tool/action failing repeatedly without a changed approach." },
  { id: "scope-drift", label: "Scope drift", description: "Work expanding beyond the stated request into unasked areas." },
  { id: "ignored-requirements", label: "Ignored requirements", description: "Stated requirements dropped or never addressed." },
  { id: "premature-completion", label: "Premature completion", description: "Completion claimed before verification or required work finished." },
  { id: "verification-gap", label: "Verification gap", description: "Changed behavior lacks tests, checks, or review evidence." },
  { id: "stale-evidence", label: "Stale evidence", description: "Decisions rely on evidence predating later source changes." },
  { id: "redundant-verification", label: "Redundant verification", description: "Re-running checks whose evidence is already current." },
  { id: "capability-misuse", label: "Capability/tool misuse", description: "Wrong tool, skill, or mechanism for the job at hand." },
  { id: "unnecessary-delegation", label: "Unnecessary delegation", description: "Delegating work the parent could do directly and cheaply." },
  { id: "review-churn", label: "Review churn", description: "Repeated review rounds without converging on concrete repairs." },
  { id: "unproductive-progress", label: "Unproductive progress", description: "Activity without movement toward the stated goal." },
  { id: "unsafe-assumptions", label: "Unsafe assumptions", description: "Acting on unverified premises about state, identity, or environment." },
] as const;

export const SPAN_SIGNAL_IDS = new Set(SPAN_CATALOG.map((signal) => signal.id));

export type SpanTraceKind =
  | "tool-call" | "tool-result" | "error" | "edit"
  | "requirement" | "review" | "delegation" | "completion" | "note";

export interface SpanTraceEvent {
  at: number;
  kind: SpanTraceKind;
  text: string;
}

export interface SpanTrace {
  events: SpanTraceEvent[];
}

export function createSpanTrace(maxEvents = SPAN_MAX_TRACE_EVENTS): {
  trace: SpanTrace;
  record: (kind: SpanTraceKind, text: unknown, at?: number) => void;
  clear: () => void;
} {
  const trace: SpanTrace = { events: [] };
  const limit = Number.isFinite(maxEvents) ? Math.max(8, Math.min(SPAN_MAX_TRACE_EVENTS, Math.floor(maxEvents))) : SPAN_MAX_TRACE_EVENTS;
  return {
    trace,
    record(kind, text, at = Date.now()) {
      if (typeof text !== "string" || !text.trim()) return;
      trace.events.push({ at: Number.isFinite(at) ? at : Date.now(), kind, text: text.replace(/\s+/g, " ").trim().slice(0, SPAN_MAX_EVENT_CHARS) });
      while (trace.events.length > limit) trace.events.shift();
    },
    clear() {
      trace.events.length = 0;
    },
  };
}

/** Stable fingerprint of meaningful trace/catalog state for caching. */
export function spanTraceFingerprint(trace: SpanTrace, signalIds: readonly string[] = SPAN_CATALOG.map((s) => s.id)): string {
  const body = JSON.stringify({
    signals: [...signalIds].sort(),
    events: trace.events.map((event) => [event.kind, event.text]),
  });
  return createHash("sha256").update(body).digest("hex");
}

export interface SpanSignalScores {
  present: number;
  absent: number;
  notObservable: number;
}

export interface SpanScoreResult {
  ok: boolean;
  /** Present only when ok: per-signal calibrated probabilities. */
  scores?: Record<string, SpanSignalScores>;
  fingerprint: string;
  events: number;
  ms: number;
  cached: boolean;
  model?: string;
  inputTokens?: number;
  costUsd?: number;
  /** Machine-readable skip reason when !ok (shadow, disabled, trivial, ...). */
  skipped?: string;
  shadow: boolean;
}

export type SpanScorer = (prompt: string, opts: {
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<{
  text: string;
  model: string;
  inputTokens?: number;
  costUsd?: number;
  ms: number;
}>;

export function spanEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !["1", "true", "yes"].includes((env.PI_OFFLINE ?? "").toLowerCase())
    && !["off", "0"].includes((env.PI_SPAN ?? "on").toLowerCase());
}

/** Shadow (record-only) unless explicitly disabled with PI_SPAN_SHADOW=0. */
export function spanShadow(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PI_SPAN_SHADOW ?? "1").toLowerCase() !== "0";
}

function noteHealth(kind: string, data: Record<string, unknown>): void {
  try {
    sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.(kind, data);
  } catch {
    /* Telemetry is optional. */
  }
}

function ledger(pi: unknown, entry: Record<string, unknown>): void {
  try {
    (pi as { appendEntry?: (type: string, data: unknown) => void })?.appendEntry?.(SPAN_USAGE_ENTRY, entry);
  } catch {
    // Accounting must never break the call it measures.
  }
}

const clamp01 = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;

/** Validate and normalize a raw scorer payload into per-signal probabilities. */
export function parseSpanScores(raw: unknown): Record<string, SpanSignalScores> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, SpanSignalScores> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!SPAN_SIGNAL_IDS.has(id) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const present = clamp01(record.present);
    const absent = clamp01(record.absent);
    const notObservable = clamp01(record.notObservable ?? record.not_observable);
    if (present === undefined || absent === undefined || notObservable === undefined) return undefined;
    const total = present + absent + notObservable;
    if (!(total > 0.9 && total < 1.11)) return undefined;
    out[id] = { present: present / total, absent: absent / total, notObservable: notObservable / total };
  }
  return Object.keys(out).length ? out : undefined;
}

export function spanPrompt(trace: SpanTrace): string {
  const lines = trace.events.map((event) => `- [${event.kind}] ${event.text}`);
  const catalog = SPAN_CATALOG.map((signal) => `${signal.id}: ${signal.description}`).join("\n");
  const prompt =
    `Score each behavior signal against the recent session trace. Reply with JSON only: ` +
    `{"<signal-id>":{"present":0..1,"absent":0..1,"notObservable":0..1}} with probabilities summing to 1. ` +
    `Use notObservable when the trace cannot show the signal. Signals:\n${catalog}\nTrace:\n${lines.join("\n")}`;
  if (prompt.length <= SPAN_MAX_INPUT_CHARS) return prompt;
  const keep = SPAN_MAX_INPUT_CHARS - 120;
  const head = Math.ceil(keep * 0.35);
  return `${prompt.slice(0, head)}\n[... ${prompt.length - keep} characters omitted ...]\n${prompt.slice(-(keep - head))}`;
}

interface SpanCacheEntry {
  scores: Record<string, SpanSignalScores>;
  model: string;
  inputTokens?: number;
  costUsd?: number;
  at: number;
}

const spanCache = new Map<string, SpanCacheEntry>();

export function clearSpanCache(): void {
  spanCache.clear();
}

export interface SpanScoreOptions {
  pi?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

/** Score a trace. Cached by fingerprint; shadow mode records but never advises. */
export async function scoreSpanTrace(
  trace: SpanTrace,
  scorer: SpanScorer | undefined,
  opts: SpanScoreOptions = {},
): Promise<SpanScoreResult> {
  const metrics = microMetrics();
  const env = opts.env ?? process.env;
  const shadow = spanShadow(env);
  const now = opts.now ?? Date.now;
  const started = now();
  const events = Array.isArray(trace?.events) ? trace.events : [];
  const fingerprint = spanTraceFingerprint({ events });
  const base = { fingerprint, events: events.length, shadow };
  if (!spanEnabled(env)) {
    metrics.skip("span", "disabled");
    return { ok: false, ...base, ms: 0, cached: false, skipped: "disabled" };
  }
  if (opts.signal?.aborted) {
    metrics.skip("span", "aborted");
    return { ok: false, ...base, ms: 0, cached: false, skipped: "aborted" };
  }
  if (events.length < 3) {
    metrics.skip("span", "trivial");
    return { ok: false, ...base, ms: 0, cached: false, skipped: "trivial" };
  }
  metrics.offer("span");
  const cached = spanCache.get(fingerprint);
  if (cached && now() - cached.at < SPAN_CACHE_TTL_MS) {
    metrics.run("span", 0);
    metrics.cacheHit("span");
    noteHealth("ml.span.used", { count: 1, cached: true, signals: Object.keys(cached.scores).length, shadow });
    // Cached rescores ledger like cached Jev answers: no new spend, but
    // /metrics still counts the reuse.
    ledger(opts.pi, {
      model: cached.model, inputTokens: 0, costUsd: 0, ms: 0, cached: true,
      signals: Object.keys(cached.scores).length,
      present: Object.values(cached.scores).filter((scores) => scores.present >= SPAN_ADVISE_THRESHOLD).length,
      shadow,
    });
    return { ok: true, ...base, scores: structuredClone(cached.scores), model: cached.model, inputTokens: 0, costUsd: 0, ms: 0, cached: true };
  }
  if (!scorer) {
    metrics.skip("span", "no-scorer");
    noteHealth("ml.span.skipped", { count: 1, reason: "no-scorer" });
    return { ok: false, ...base, ms: 0, cached: false, skipped: "no-scorer" };
  }
  const finish = beginHarnessActivity("span");
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.min(2_147_483_647, opts.timeoutMs!)) : SPAN_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new DOMException("Span timeout", "TimeoutError")), timeoutMs);
  let succeeded = false;
  try {
    const prompt = spanPrompt({ events });
    const answer = await raceWithAbortSignal(Promise.resolve(scorer(prompt, { signal, timeoutMs })), signal);
    signal.throwIfAborted();
    const ms = Math.max(0, now() - started);
    let parsed: Record<string, SpanSignalScores> | undefined;
    try {
      parsed = parseSpanScores(JSON.parse(answer.text));
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      metrics.skip("span", "malformed");
      noteHealth("ml.span.skipped", { count: 1, reason: "malformed", durationMs: ms });
      return { ok: false, ...base, ms, cached: false, skipped: "malformed" };
    }
    metrics.run("span", ms, prompt.length);
    if (spanCache.size >= SPAN_CACHE_MAX) spanCache.delete(spanCache.keys().next().value!);
    spanCache.set(fingerprint, { scores: structuredClone(parsed), model: answer.model, inputTokens: answer.inputTokens, costUsd: answer.costUsd, at: now() });
    const presentCount = Object.values(parsed).filter((scores) => scores.present >= SPAN_ADVISE_THRESHOLD).length;
    ledger(opts.pi, { model: answer.model, inputTokens: answer.inputTokens ?? 0, costUsd: answer.costUsd ?? 0, ms, cached: false, signals: Object.keys(parsed).length, present: presentCount, shadow });
    const present = Object.entries(parsed).filter(([, scores]) => scores.present >= SPAN_ADVISE_THRESHOLD).map(([id]) => id);
    // Shadow evaluations stay out of the transcript activity feed (the
    // shadow flag suppresses display); the health sink still records them
    // for metrics/export consumers.
    noteHealth("ml.span.used", {
      count: 1, cached: false, durationMs: ms, route: answer.model,
      signals: Object.keys(parsed).length, present: present.length, shadow,
    });
    if (!shadow && present.length) metrics.accept("span");
    else metrics.skip("span", shadow ? "shadow" : "absent");
    succeeded = true;
    return { ok: true, ...base, scores: parsed, model: answer.model, inputTokens: answer.inputTokens, costUsd: answer.costUsd, ms, cached: false };
  } catch (error) {
    const ms = Math.max(0, now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const reason = opts.signal?.aborted ? 'aborted' : controller.signal.aborted ? 'timeout' : /invalid model|model not found|404/i.test(message) ? "route-unavailable"
      : /timeout|aborted/i.test(message) ? "timeout" : "unavailable";
    metrics.skip("span", reason);
    noteHealth("ml.span.skipped", { count: 1, reason, durationMs: ms });
    return { ok: false, ...base, ms, cached: false, skipped: reason };
  } finally {
    clearTimeout(timer);
    try { finish(succeeded ? 'ok' : opts.signal?.aborted ? 'cancelled' : 'error'); } catch { /* display only */ }
  }
}

export interface SpanAdvisory {
  /** Signal ids cleared for consumer use (threshold + corroboration met). */
  signals: string[];
  /** Strong-scoring signals held back for lack of deterministic corroboration. */
  uncorroborated: string[];
  shadow: boolean;
}

/** Gate Span scores into consumer advice. Deterministic corroboration is
 * required for every advised signal; shadow results never advise. */
export function spanAdvisory(
  result: SpanScoreResult,
  corroborated: ReadonlySet<string> | readonly string[] = [],
): SpanAdvisory {
  const allowed = new Set(Array.isArray(corroborated) ? corroborated : [...corroborated]);
  if (!result.ok || !result.scores || result.shadow) return { signals: [], uncorroborated: [], shadow: result.shadow };
  const signals: string[] = [];
  const uncorroborated: string[] = [];
  for (const [id, scores] of Object.entries(result.scores)) {
    if (!SPAN_SIGNAL_IDS.has(id) || scores.present < SPAN_ADVISE_THRESHOLD) continue;
    if (allowed.has(id)) signals.push(id);
    else uncorroborated.push(id);
  }
  return { signals, uncorroborated, shadow: false };
}

export interface OpenRouterSpanScorerOptions {
  model?: string;
  fallback?: string;
  key?: () => string | undefined;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** Default OpenRouter chat-completions scorer with paid-model fallback. */
export function openRouterSpanScorer(opts: OpenRouterSpanScorerOptions = {}): SpanScorer {
  const env = opts.env ?? process.env;
  const primary = opts.model ?? env.PI_SPAN_MODEL ?? SPAN_DEFAULT_MODEL;
  const fallback = opts.fallback ?? env.PI_SPAN_FALLBACK ?? SPAN_DEFAULT_FALLBACK;
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const keyOf = opts.key ?? openRouterKey;
  const post = async (model: string, prompt: string, signal: AbortSignal | undefined, timeoutMs: number) => {
    const key = keyOf();
    if (!key) throw Error("span: no OpenRouter key");
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Span route timeout", "TimeoutError")), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    try {
      const response = await fetchImpl(SPAN_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/yunusemrejr/yunuspi",
          "X-Title": "yunuspi-span-sensor",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 1200,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const err = Error(`span ${response.status}${/model not found|invalid model|404/i.test(body) || response.status === 404 ? ": invalid model" : ""}`) as Error & { status?: number };
        err.status = response.status;
        throw err;
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; cost?: number };
      };
      controller.signal.throwIfAborted();
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw Error("span: malformed answers");
      return {
        text,
        model,
        inputTokens: typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : undefined,
        costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : undefined,
        ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  return async (prompt, callOpts) => {
    const timeoutMs = callOpts.timeoutMs ?? SPAN_REQUEST_TIMEOUT_MS;
    try {
      return await post(primary, prompt, callOpts.signal, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Fall back to the paid Span route only when the Lite route itself is
      // missing — never on auth, quota, timeout, or malformed answers.
      if (fallback !== primary && /invalid model|model not found/i.test(message)) {
        return await post(fallback, prompt, callOpts.signal, timeoutMs);
      }
      throw error;
    }
  };
}

export function spanStatus(env: Record<string, string | undefined> = process.env): {
  enabled: boolean;
  shadow: boolean;
  model: string;
  fallback: string;
  key: boolean;
  cacheEntries: number;
} {
  return {
    enabled: spanEnabled(env),
    shadow: spanShadow(env),
    model: env.PI_SPAN_MODEL ?? SPAN_DEFAULT_MODEL,
    fallback: env.PI_SPAN_FALLBACK ?? SPAN_DEFAULT_FALLBACK,
    key: openRouterKey() !== undefined,
    cacheEntries: spanCache.size,
  };
}
