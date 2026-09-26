import { sessionObservability } from './session-observability.ts';
/** Shared TypeSafe Jev judgment client, served through the configured
 * OpenRouter key. Jev answers typed questions (noul/choice/score) over a
 * state — no prose — which makes it a cheap mechanical judge for routing,
 * screening, ranking, verifying, classifying, distilling and triage.
 *
 * Resilience contract (every consumer keeps its heuristic path; Jev refines,
 * never gates):
 * - Jev and Kev split uncached work, with per-family cooldowns and same-call
 *   failover. Jev's alias cascade remains inside its route; a failed Jev alias
 *   is not a separate healthy model. Account-level failures stop both routes.
 * - Both routes failing opens the existing breaker. Recovery is bounded;
 *   a cooling route is retried by one real request after its cooldown.
 * - Answers are deduplicated per session (identical state+questions pay
 *   once) and every paid call is ledgered as a `jev-usage-v1` session
 *   entry so cost and metrics treat Jev like any other provider route.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { protectedEvidence } from "./local-intelligence.mjs";
import { microMetrics } from './micro-intelligence/metrics.ts';
import { beginHarnessActivity } from './harness-activity.ts';

export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const JEV_PREFERRED_SLUGS = ["~typesafe/jev-latest", "typesafe/jev-1.13"];
export const KEV_SLUG = "jaredpalmer/kev-4b";
export const JEV_PRICE_PER_M_INPUT = 0.042;
export const JEV_REQUEST_TIMEOUT_MS = 15_000;
export const JEV_DISCOVERY_TTL_MS = 10 * 60 * 1000;
export const JEV_CACHE_TTL_MS = 30 * 60 * 1000;
const JEV_CACHE_MAX = 500;
export const JEV_MAX_INPUT_CHARS = 32768;
export const JEV_REMOTE_PROVIDER = "OpenRouter";
export const JEV_INPUT_POLICY = `When the Jev/Kev judge is enabled, bounded task/request excerpts may be sent to ${JEV_REMOTE_PROVIDER}; the input is capped at ${JEV_MAX_INPUT_CHARS} characters. Set PI_JEV=off (or PI_JEV=0) to disable both remote judge routes.`;

export function jevEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !['1', 'true', 'yes'].includes((env.PI_OFFLINE ?? '').toLowerCase())
    && !['off', '0'].includes((env.PI_JEV ?? 'on').toLowerCase());
}

const agentDir = (): string =>
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/** OpenRouter key: models.json provider entry ($VAR expanded), else env. */
export function openRouterKey(): string | undefined {
  try {
    const json = JSON.parse(
      readFileSync(join(agentDir(), "models.json"), "utf-8"),
    ) as { providers?: Record<string, { apiKey?: string }> };
    const raw = json.providers?.openrouter?.apiKey;
    if (typeof raw === "string" && raw.startsWith("$")) {
      const expanded = process.env[raw.slice(1)];
      if (expanded) return expanded;
    } else if (typeof raw === "string" && raw.length > 0) {
      return raw;
    }
  } catch {
    // Missing/unreadable config falls through to env.
  }
  return process.env.OPENROUTER_API_KEY ?? undefined;
}

export const estimateJevTokens = (chars: number): number =>
  Math.max(1, Math.ceil(Math.max(0, chars) / 4));

export const jevCostUsd = (inputTokens: number): number =>
  (Math.max(0, inputTokens) / 1_000_000) * JEV_PRICE_PER_M_INPUT;

/** Input price evidence ($/M) for a judge slug. Only the documented Jev
 * family price is presumed; Kev and discovered aliases report unknown cost
 * unless the decisions response carries provider-reported usage. Assigning
 * Jev's price to another model manufactures auxiliary-cost accounting. */
export function resolveJevInputPricePerM(slug: string): number | undefined {
  return (JEV_PREFERRED_SLUGS as readonly string[]).includes(slug) ? JEV_PRICE_PER_M_INPUT : undefined;
}

const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;

/** TUI marker appended next to whatever a Jev call served. */
export function jevMark(
  site: string,
  detail: string,
  usage: { inputTokens: number; cached: boolean },
): string {
  const cost = usage.cached ? "cached 0 tok" : `${fmtTokens(usage.inputTokens)} tok`;
  return `[successfully routed with Jev · ${site}${detail ? ` · ${detail}` : ""} · ${cost}]`;
}

export type JevAnswer = {
  type: string;
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  score?: number;
  legend?: Record<string, string>;
};

export type JevAskResult =
  | {
      ok: true;
      answers: Record<string, JevAnswer>;
      usage: {
        model: string;
        inputTokens: number;
        /** Undefined when neither the provider nor route price evidence
         * establishes a cost; consumers must treat it as unknown, not zero. */
        costUsd: number | undefined;
        ms: number;
        cached: boolean;
      };
    }
  | { ok: false; skipped: string };

type Deps = {
  fetchImpl: typeof fetch;
  now: () => number;
  schedule: (fn: () => void, ms: number) => { unref?: () => void };
  openMs: number;
  requestTimeoutMs: number;
};

const deps: Deps = {
  fetchImpl: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer as unknown as { unref?: () => void };
  },
  openMs: 5 * 60 * 1000,
  requestTimeoutMs: JEV_REQUEST_TIMEOUT_MS,
};

/** Test seam: inject fetch/clock/timers and shrink the breaker window. */
export function configureJevClient(partial: Partial<Deps>): void {
  Object.assign(deps, partial);
}

type JudgeFamily = "jev" | "kev";
const families: JudgeFamily[] = ["jev", "kev"];
const routeHealth = { jev: { retryAt: 0, active: 0, failures: 0 }, kev: { retryAt: 0, active: 0, failures: 0 } };
let nextFamily: JudgeFamily = "jev";
let generation = 0;
let stickySlug: string | undefined;
let breakerOpen = false;
let breakerOpenedAt = 0;
let probeScheduled = false;
let lastError = "";
let discovered: { at: number; slugs: string[] } = { at: 0, slugs: [] };
let discoveryInflight: Promise<string[]> | null = null;
const cache = new Map<string, { answers: Record<string, JevAnswer>; inputTokens: number; model: string; at: number }>();
type InflightEntry = {
  promise: Promise<JevAskResult>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  charged: boolean;
};
const inflight = new Map<string, InflightEntry>();

/** Test seam: reset every module singleton. */
export function resetJevClient(): void {
  generation++;
  nextFamily = "jev";
  for (const route of Object.values(routeHealth)) Object.assign(route, { retryAt: 0, active: 0, failures: 0 });
  stickySlug = undefined;
  breakerOpen = false;
  breakerOpenedAt = 0;
  probeScheduled = false;
  lastError = "";
  discovered = { at: 0, slugs: [] };
  discoveryInflight = null;
  cache.clear();
  for (const entry of inflight.values()) entry.controller.abort(new DOMException('Jev client reset', 'AbortError'));
  inflight.clear();
}

export function jevHealth(): {
  state: "closed" | "open";
  slug?: string;
  lastError: string;
  nextProbeInMs: number;
  routes: Array<{ family: JudgeFamily; model: string; state: "ready" | "cooling" | "probing"; active: number; retryInMs: number }>;
} {
  return {
    routes: families.map(family => ({ family, model: family === "kev" ? KEV_SLUG : stickySlug ?? JEV_PREFERRED_SLUGS[0],
      state: routeHealth[family].retryAt > deps.now() ? "cooling" : routeHealth[family].retryAt && routeHealth[family].active ? "probing" : "ready",
      active: routeHealth[family].active, retryInMs: Math.max(0, routeHealth[family].retryAt - deps.now()) })),
    state: breakerOpen ? "open" : "closed",
    slug: stickySlug,
    lastError,
    nextProbeInMs: breakerOpen
      ? Math.max(0, breakerOpenedAt + deps.openMs - deps.now())
      : 0,
  };
}

function cacheKey(slug: string, state: unknown, questions: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([slug, state, questions]))
    .digest("hex");
}

function cacheGet(key: string): { answers: Record<string, JevAnswer>; inputTokens: number; model: string } | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (deps.now() - hit.at > JEV_CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit;
}

function cacheSet(key: string, value: { answers: Record<string, JevAnswer>; inputTokens: number; model: string }): void {
  if (cache.size >= JEV_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ...value, answers: structuredClone(value.answers), at: deps.now() });
}

/** Any jev variation OpenRouter lists, typesafe-authored first. */
async function discoverSlugs(): Promise<string[]> {
  if (deps.now() - discovered.at < JEV_DISCOVERY_TTL_MS) return discovered.slugs;
  if (discoveryInflight) return discoveryInflight;
  discoveryInflight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await deps.fetchImpl(JEV_MODELS_URL, { signal: controller.signal });
        if (!response.ok) return discovered.slugs;
        const body = (await response.json()) as { data?: Array<{ id?: string }> };
        const ids = (body.data ?? [])
          .map((entry) => entry?.id)
          .filter((id): id is string => typeof id === "string" && /^~?typesafe\/jev[-\w.]*$/.test(id));
        ids.sort((a, b) => Number(b.startsWith("typesafe/")) - Number(a.startsWith("typesafe/")));
        discovered = { at: deps.now(), slugs: [...new Set(ids)] };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Discovery is opportunistic; the preferred slugs stand alone.
    } finally {
      discoveryInflight = null;
    }
    return discovered.slugs;
  })();
  return discoveryInflight;
}

/** Full cascade order: preferred slugs, then discovered variations. */
export async function jevCascadeSlugs(): Promise<string[]> {
  const found = await discoverSlugs();
  return [...new Set([...JEV_PREFERRED_SLUGS, ...found])];
}

function ledger(
  pi: unknown,
  entry: {
    site: string;
    model: string;
    inputTokens: number;
    costUsd: number | undefined;
    ms: number;
    cached: boolean;
  },
): void {
  try {
    (pi as { appendEntry?: (type: string, data: unknown) => void })?.appendEntry?.("jev-usage-v1", entry);
  } catch {
    // Accounting must never break the call it measures.
  }
}

const PROBE_STATE = "ok";
const PROBE_QUESTIONS = { ping: { type: "noul", instructions: "Is this text affirmative?" } };

async function postDecisions(
  slug: string,
  state: unknown,
  questions: Record<string, unknown>,
  key: string,
  signal?: AbortSignal,
  timeoutMs = JEV_REQUEST_TIMEOUT_MS,
): Promise<{ answers: Record<string, JevAnswer>; inputTokens?: number; costUsd?: number }> {
  signal?.throwIfAborted();
  const finish = beginHarnessActivity('jev');
  let returned = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Judge route timeout", "TimeoutError")), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await deps.fetchImpl(JEV_DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/yunusemrejr/yunuspi",
        "X-Title": "yunuspi",
      },
      body: JSON.stringify({ model: slug, state, questions }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Provider error bodies may echo the submitted state. Retain only the
      // status and safe model-rejection category in health/UI diagnostics.
      const err = Error(`decisions ${response.status}${isModelRejection(response.status, body) ? ': invalid model' : ''}`) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }
    const body = (await response.json()) as { answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number; cost?: number } };
    controller.signal.throwIfAborted();
    if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object" || Array.isArray(body.answers))
      throw Error("decisions: malformed answers");
    // Validate the requested typed values before they reach routing, caches,
    // intent guards or review planning. HTTP success is not a valid judgment.
    const unit = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    for (const [name, question] of Object.entries(questions)) {
      const q = question as { type?: string; criteria?: Record<string, unknown> };
      const answer = body.answers[name];
      if (!Object.hasOwn(body.answers, name) || !answer || answer.type !== q.type
        || q.type === 'noul' && !unit(answer.noul)
        || q.type === 'score' && !Number.isFinite(answer.score)
        || q.type === 'choice' && (typeof answer.choice !== 'string' || !q.criteria || !Object.hasOwn(q.criteria, answer.choice)
          || !answer.probabilities || typeof answer.probabilities !== 'object' || Array.isArray(answer.probabilities)
          || !Object.hasOwn(answer.probabilities, answer.choice)
          || Object.entries(answer.probabilities).some(([id, value]) => !Object.hasOwn(q.criteria!, id) || !unit(value)))) {
        throw Error('decisions: malformed answers');
      }
    }
    returned = true;
    return { answers: body.answers,
      inputTokens: Number.isSafeInteger(body.usage?.input_tokens) && body.usage!.input_tokens! >= 0 ? body.usage!.input_tokens : undefined,
      costUsd: typeof body.usage?.cost === "number" && Number.isFinite(body.usage.cost) && body.usage.cost >= 0 ? body.usage.cost : undefined };
  } finally {
    finish(returned ? 'ok' : signal?.aborted && signal.reason?.name !== 'TimeoutError' ? 'cancelled' : 'error');
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function isModelRejection(status: number | undefined, message: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /model|slug/i.test(message) && /unknown|not\s*found|invalid|unavailable|unsupported|not\s+supported|does\s+not\s+exist/i.test(message);
}

function openBreaker(reason: string): void {
  breakerOpen = true;
  breakerOpenedAt = deps.now();
  lastError = reason.slice(0, 240);
  scheduleProbe();
}

function scheduleProbe(): void {
  if (probeScheduled) return;
  probeScheduled = true;
  const epoch = generation;
  deps.schedule(() => {
    if (epoch !== generation) return;
    probeScheduled = false;
    void recoverProbe();
  }, Math.max(0, breakerOpenedAt + deps.openMs - deps.now()));
}

async function recoverProbe(): Promise<void> {
  if (!breakerOpen) return;
  if (!jevEnabled()) return;
  const key = openRouterKey();
  if (!key) {
    openBreaker("recover probe: no OpenRouter key");
    return;
  }
  // Reuse the same bounded route selection, validation and accounting owner.
  // No alias discovery or request can outlive the normal overall deadline.
  const epoch = generation;
  breakerOpen = false;
  for (const route of Object.values(routeHealth)) route.retryAt = 0;
  const result = await boundedAsk(PROBE_STATE, PROBE_QUESTIONS, {});
  if (epoch !== generation) return;
  if (!result.ok) { if (!breakerOpen) openBreaker("recover probe: routes unavailable"); }
  else lastError = "";
}

export type JevAskOpts = {
  pi?: unknown;
  signal?: AbortSignal;
  /** Top-level state fields the input fitter must never trim. */
  protect?: readonly string[];
};

function knownSlugs(): string[] {
  return [...new Set([...(stickySlug ? [stickySlug] : []), ...JEV_PREFERRED_SLUGS, ...discovered.slugs, KEV_SLUG])];
}

/** Catalog discovery is shared, but a cancelled caller need not wait for it. */
async function discoverForCaller(signal?: AbortSignal): Promise<string[]> {
  if (!signal) return jevCascadeSlugs();
  if (signal.aborted) return [];
  let cancel!: () => void;
  const aborted = new Promise<string[]>(resolve => { cancel = () => resolve([]); });
  signal.addEventListener('abort', cancel, { once: true });
  try { return await Promise.race([jevCascadeSlugs(), aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

/**
 * One batched judgment call. Returns answers or a fallback directive —
 * callers treat every non-ok result as "use the heuristic path".
 */
/** Oversized evidence is trimmed instead of refused: the longest string
 * fields of an object state lose their middle (with an explicit marker) until
 * the request fits. Health logs showed every Jev refusal was input-budget,
 * which silently dropped the judgement. Question text is never altered.
 * Fields named in `protect` are never trimmed: decisive constraints cannot
 * disappear merely because they sit in the middle of a long string. When the
 * state still exceeds the budget after trimming the unprotected fields, it is
 * returned oversized and the transport abstains with input-budget instead of
 * judging semantically damaged evidence. */
export function fitJevState(state: unknown, questions: Record<string, unknown>, opts: { protect?: readonly string[] } = {}): unknown {
  let size: number;
  try { size = JSON.stringify([state, questions]).length; } catch { return state; }
  if (size <= JEV_MAX_INPUT_CHARS) return state;
  if (typeof state === "string") return trimMiddle(state, Math.max(1000, state.length - (size - JEV_MAX_INPUT_CHARS) - 200));
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const guarded = new Set(opts.protect ?? []);
  const next: Record<string, unknown> = { ...(state as Record<string, unknown>) };
  for (let guard = 0; guard < 8; guard++) {
    const over = JSON.stringify([next, questions]).length - JEV_MAX_INPUT_CHARS;
    if (over <= 0) break;
    const [key, value] = Object.entries(next).filter(([k, v]) => typeof v === "string" && !guarded.has(k)).sort((a, b) => (b[1] as string).length - (a[1] as string).length)[0] ?? [];
    if (!key || (value as string).length < 2000) break;
    next[key] = trimMiddle(value as string, Math.max(1000, (value as string).length - over - 200));
  }
  return next;
}
function trimMiddle(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const head = Math.ceil(keep * 0.6), tail = keep - head;
  return `${text.slice(0, head)}\n[... ${text.length - keep} characters omitted to fit the judge's input budget ...]\n${text.slice(-tail)}`;
}

export async function askJev(
  site: string,
  state: unknown,
  questions: Record<string, unknown>,
  opts: JevAskOpts = {},
): Promise<JevAskResult> {
  const started = deps.now();
  const result = await askJevShared(site, fitJevState(state, questions, { protect: opts.protect }), questions, opts);
  // Report every caller's result in its session scope, including admission
  // failures which never reached the transient transport/footer indicator.
  // Only the controlled reason is emitted: state and provider errors stay out.
  try {
    sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.(result.ok ? "ml.jev.used" : "ml.jev.skipped", result.ok
      ? { count: 1, cached: result.usage.cached, route: result.usage.model, durationMs: result.usage.ms, questions: Object.keys(questions).length }
      : { count: 1, reason: result.skipped, site: site.slice(0, 40), durationMs: Math.max(0, deps.now() - started) });
  } catch { /* optional visibility */ }
  return result;
}

async function askJevShared(site: string, state: unknown, questions: Record<string, unknown>, opts: JevAskOpts): Promise<JevAskResult> {
  // A caller can leave its own wait without cancelling an identical shared
  // transport. The last cancelled waiter aborts the underlying request so a
  // stale advisory cannot keep consuming network/provider time.
  // Disabled must never reach the network: fall through to boundedAsk would
  // still bill when PI_JEV=0 (askJevOnce used to accept only the literal "off").
  if (!jevEnabled()) return { ok: false, skipped: "disabled" };
  if (opts.signal?.aborted) return { ok: false, skipped: "aborted" };
  let identity: string;
  try { identity=cacheKey('inflight',state,questions); } catch { return {ok:false,skipped:'invalid-input'}; }
  let entry=inflight.get(identity);
  if (!entry) {
    if(inflight.size>=64)return {ok:false,skipped:'busy'};
    const controller=new AbortController();
    entry={controller,waiters:0,settled:false,charged:false,promise:Promise.resolve({ok:false,skipped:'unavailable'})};
    entry.promise=(async()=>{
      try { return await boundedAsk(state,questions,{...opts,signal:controller.signal}); }
      catch { return {ok:false,skipped:'unavailable'}; }
      finally {
        entry!.settled=true;
        if(inflight.get(identity)===entry)inflight.delete(identity);
      }
    })();
    inflight.set(identity,entry);
  }
  entry.waiters++;
  let aborted=false;
  let waiterReleased=false;
  const releaseWaiter=()=>{
    if(waiterReleased)return;
    waiterReleased=true;
    entry!.waiters=Math.max(0,entry!.waiters-1);
    if(entry!.waiters===0&&!entry!.settled){
      if(inflight.get(identity)===entry)inflight.delete(identity);
      entry!.controller.abort(new DOMException('All Jev callers cancelled', 'AbortError'));
    }
  };
  try {
    const waited=await waitForInflight(entry,opts.signal,releaseWaiter);
    aborted=waited.aborted;
    if (aborted) return {ok:false,skipped:'aborted'};
    const result=waited.result!;
    if (!result.ok) return result;
    if (!result.usage.cached && !entry.charged) {
      entry.charged = true;
      ledger(opts.pi, { site, ...result.usage });
      return { ...result, answers: structuredClone(result.answers) };
    }
    const usage={...result.usage,inputTokens:0,costUsd:0,cached:true};
    ledger(opts.pi,{site,...usage});
    return {ok:true,answers:structuredClone(result.answers),usage};
  } finally {
    if(!waiterReleased)entry.waiters=Math.max(0,entry.waiters-1);
  }
}

async function waitForInflight(entry: InflightEntry, signal?: AbortSignal, onAbort?:()=>void): Promise<{result?:JevAskResult;aborted:boolean}> {
  if (!signal) return {result:await entry.promise,aborted:false};
  if (signal.aborted) { onAbort?.(); return {aborted:true}; }
  let abort!: () => void;
  const cancelled=new Promise<{aborted:true}>(resolve=>{abort=()=>{onAbort?.();resolve({aborted:true});};signal.addEventListener('abort',abort,{once:true});});
  try { return await Promise.race([entry.promise.then(result=>({result,aborted:false})),cancelled]); }
  finally { signal.removeEventListener('abort',abort); }
}

/** One deadline covers the entire alias cascade and discovery, not each
 * alias independently. Cancellation never poisons provider health. */
async function boundedAsk(state: unknown, questions: Record<string, unknown>, opts: JevAskOpts): Promise<JevAskResult> {
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException('JEV deadline exceeded', 'TimeoutError')), deps.requestTimeoutMs);
  try {
    const result = await askJevOnce(state, questions, { ...opts, signal });
    return controller.signal.aborted && !opts.signal?.aborted ? { ok: false, skipped: 'timeout' } : result;
  } finally { clearTimeout(timer); }
}

async function askJevOnce(
  state: unknown,
  questions: Record<string, unknown>,
  opts: JevAskOpts = {},
): Promise<JevAskResult> {
  if (!jevEnabled()) return { ok: false, skipped: "disabled" };
  if (state === undefined || state === null || (typeof state === "string" && !state.trim()))
    return { ok: false, skipped: "trivial" };
  if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0)
    return { ok: false, skipped: "trivial" };
  const key = openRouterKey();
  if (!key) return { ok: false, skipped: "no-key" };
  if (opts.signal?.aborted) return { ok: false, skipped: "aborted" };
  if (breakerOpen) {
    scheduleProbe();
    return { ok: false, skipped: "unhealthy" };
  }

  let payloadChars: number;
  try { payloadChars = JSON.stringify([state, questions]).length; }
  catch { return { ok: false, skipped: 'invalid-input' }; }
  if (payloadChars > JEV_MAX_INPUT_CHARS) return { ok: false, skipped: 'input-budget' };
  const inputTokens = estimateJevTokens(payloadChars);
  const started = deps.now();
  // Known-good and preferred routes need no catalog request. Discover other
  // aliases only after all known ones explicitly reject the requested model.
  const ordered = knownSlugs();
  for (const slug of ordered) {
    const hit = cacheGet(cacheKey(slug, state, questions));
    if (hit) {
      beginHarnessActivity('jev')('cached');
      return {
        ok: true,
        answers: structuredClone(hit.answers),
        usage: { model: slug, inputTokens: 0, costUsd: 0, ms: deps.now() - started, cached: true },
      };
    }
  }
  const epoch = generation;
  // Cache hits above do not advance traffic. Equal-load healthy families
  // alternate; a recovering route admits only one probationary request.
  const eligible = families.filter(family => routeHealth[family].retryAt <= deps.now()
    && !(routeHealth[family].retryAt && routeHealth[family].active));
  eligible.sort((a, b) => routeHealth[a].active - routeHealth[b].active || (a === nextFamily ? -1 : 1));
  if (!eligible.length) return { ok: false, skipped: "unhealthy" };
  nextFamily = eligible[0] === "jev" ? "kev" : "jev";
  for (const family of eligible) {
    if (opts.signal?.aborted || epoch !== generation) return { ok: false, skipped: "aborted" };
    const route = routeHealth[family];
    if (route.retryAt > deps.now() || route.retryAt && route.active) continue;
    route.active++;
    const familyStarted = deps.now();
    // Reserve time for the other route inside the one overall deadline.
    const familyBudget = Math.max(1, Math.floor(deps.requestTimeoutMs * 0.45));
    const familyController = new AbortController();
    const familyTimer = setTimeout(() => familyController.abort(new DOMException("Judge route timeout", "TimeoutError")), familyBudget);
    const familySignal = opts.signal ? AbortSignal.any([opts.signal, familyController.signal]) : familyController.signal;
    const slugs = family === "kev" ? [KEV_SLUG] : knownSlugs().filter(slug => slug !== KEV_SLUG);
    let searched = family === "kev";
    try {
      for (let index = 0; ; index++) {
        if (index >= slugs.length) {
          if (searched) break;
          searched = true;
          const found = await discoverForCaller(familySignal);
          if (opts.signal?.aborted || epoch !== generation) return { ok: false, skipped: "aborted" };
          slugs.push(...found.filter(slug => !slugs.includes(slug)).slice(0, 4));
          if (index >= slugs.length) break;
        }
        const remaining = familyBudget - (deps.now() - familyStarted);
        if (remaining <= 0 || familySignal.aborted) break;
        const slug = slugs[index];
        try {
          const response = await postDecisions(slug, state, questions, key, familySignal, remaining);
          if (epoch !== generation) return { ok: false, skipped: "aborted" };
          route.retryAt = 0; route.failures = 0;
          if (family === "jev") stickySlug = slug;
          lastError = "";
          const tokens = response.inputTokens ?? inputTokens;
          const routePrice = resolveJevInputPricePerM(slug);
          const costUsd = response.costUsd ?? (routePrice === undefined ? undefined : (Math.max(0, tokens) / 1_000_000) * routePrice);
          cacheSet(cacheKey(slug, state, questions), { answers: response.answers, inputTokens: tokens, model: slug });
          return { ok: true, answers: response.answers, usage: { model: slug, inputTokens: tokens, costUsd, ms: deps.now() - started, cached: false } };
        } catch (error) {
          if (opts.signal?.aborted || epoch !== generation) return { ok: false, skipped: "aborted" };
          const status = (error as { status?: number }).status;
          // No provider echo, network exception text or input in health state.
          lastError = status ? `decisions ${status}` : "judge transport or response failure";
          if (isModelRejection(status, error instanceof Error ? error.message : "")) {
            if (slug === stickySlug) stickySlug = undefined;
            continue;
          }
          // Shared account/request failures cannot be repaired by another model.
          if (status === 400 || status === 401 || status === 402 || status === 403 || status === 413 || status === 422) {
            openBreaker(lastError);
            return { ok: false, skipped: "unavailable" };
          }
          break; // transport, timeout, 429, 5xx or malformed answer: other family
        }
      }
      route.failures++;
      route.retryAt = deps.now() + deps.openMs;
    } finally {
      clearTimeout(familyTimer);
      if (epoch === generation) route.active = Math.max(0, route.active - 1);
    }
  }
  if (families.every(family => routeHealth[family].retryAt > deps.now())) openBreaker("both judge routes unavailable");
  return { ok: false, skipped: "unavailable" };
}

/** Guard helper: skip judgments the input cannot support. Exported for tests. */
export function tooShort(text: unknown, minChars: number): boolean {
  return typeof text !== "string" || text.trim().length < minChars;
}

/** Split complete text into bounded line-aware chunks. Empty means the whole
 * source cannot fit; callers must retain the original, never a hidden prefix. */
export function splitTextChunks(text: string, maxChunks = 8, chunkChars = 2000): string[] {
  if (!text || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || !Number.isSafeInteger(chunkChars) || chunkChars < 1) return [];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > chunkChars) return [];
    if (current && current.length + line.length + 1 > chunkChars) {
      chunks.push(current);
      current = "";
      if (chunks.length >= maxChunks) return [];
    }
    current += (current ? "\n" : "") + line;
  }
  if (current && chunks.length < maxChunks) chunks.push(current);
  return chunks;
}

/** Terminal output keeps chunks that carry outcome signals. The general
 * protection (any digit, path or hedge word) marks every chunk of a real log
 * as required, so Jev was never consulted on terminal output. */
const terminalSignal = /\b(?:error\w*|fail\w*|warn\w*|exception|traceback|panic|fatal|denied|refused|reject\w*|blocked|abort\w*|cancel\w*|timeout|timed out|assert\w*|exit(?:ed)? (?:code|status)|must|required|deprecated|conflict\w*|not found|missing|unresolved|summary|total|passed|skipped)\b/i;

/** Score text chunks for distillation. First and last chunks are always
 * kept; middle chunks need `keepAt` (0-1). Returns the rendered selection
 * with its TUI mark, or undefined when nothing should change. The `ask`
 * dependency lets tests drive the orchestration without transport. `task`
 * grounds the relevance question; without it Jev judged relevance blind. */
export async function selectDistillChunks(
  tool: string,
  text: string,
  ask: (
    site: string,
    state: unknown,
    questions: Record<string, unknown>,
    opts?: { protect?: readonly string[] },
  ) => Promise<JevAskResult>,
  keepAt = 0.6,
  task = "",
): Promise<string | undefined> {
  const chunks = splitTextChunks(text, 8, 2000);
  if (chunks.length < 2) return undefined;
  const signal = tool === "bash" ? terminalSignal : protectedEvidence;
  const required = chunks.map((chunk, index) => index === 0 || index === chunks.length - 1 || signal.test(chunk));
  if (required.every(Boolean)) return undefined;
  const metrics=microMetrics();metrics.offer('jev');
  const questions: Record<string, unknown> = {};
  chunks.forEach((_, index) => {
    questions[`chunk_${index}`] = {
      type: "noul",
      instructions: `Does chunk ${index} carry information relevant to the task (errors, results, decisions, data)?`,
    };
  });
  const judged = await ask(
    "distill",
    { ...(task ? { task: task.slice(0, 600) } : {}), tool, chunks: chunks.map((chunk, index) => `[chunk ${index}]\n${chunk}`).join("\n\n") },
    questions,
    { protect: ["task", "tool"] },
  );
  if (!judged.ok) {metrics.skip('jev',judged.skipped);return undefined;}
  metrics.run('jev',judged.usage.ms,text.length);
  metrics.jevUsage('distill',chunks.length,judged.usage.inputTokens,judged.usage.costUsd,judged.usage.cached);
  if(judged.usage.cached)metrics.cacheHit('jev');
  const kept = chunks.map(
    (_, index) =>
      required[index] ||
      // Missing, mistyped or non-finite judgments cannot authorize omission.
      judged.answers[`chunk_${index}`]?.type !== "noul" ||
      !Number.isFinite(judged.answers[`chunk_${index}`]?.noul) ||
      judged.answers[`chunk_${index}`].noul! < 0 ||
      judged.answers[`chunk_${index}`].noul! > 1 ||
      judged.answers[`chunk_${index}`].noul! >= keepAt,
  );
  if (kept.every(Boolean)) return undefined;
  const keptCount = kept.filter(Boolean).length;
  const rendered = renderKeptChunks(chunks, kept);
  if (!rendered) return undefined;
  const projection = `${rendered}\n\n${jevMark("distill", `kept ${keptCount}/${chunks.length}`, judged.usage)}`;
  if(text.length-projection.length<256)return undefined;
  metrics.accept('jev',text.length-projection.length,true);
  return projection;
}

/** Render kept chunk indexes extractively with omission notes. */
export function renderKeptChunks(chunks: string[], kept: boolean[], maxChars = 12000): string {
  const parts: string[] = [];
  let omitted = 0;
  chunks.forEach((chunk, index) => {
    if (kept[index]) {
      if (omitted > 0) {
        parts.push(`[...${omitted} chunk(s) omitted...]`);
        omitted = 0;
      }
      parts.push(chunk);
    } else {
      omitted++;
    }
  });
  if (omitted > 0) parts.push(`[...${omitted} trailing chunk(s) omitted...]`);
  const joined = parts.join("\n\n");
  // A render limit may reject a selection; it must never cut retained facts.
  return joined.length > maxChars ? "" : joined;
}
