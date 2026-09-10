/**
 * provider-health.ts — shared, executable provider cooldown/rate state.
 *
 * WHY THIS EXISTS (fix_provider_cooldown_enforcement): cooldowns used to live
 * only as per-process retry-loop state (`_piRateLimitLoopStart`) and as
 * autonomous-recovery prose. A session that declared "cooldown" on a provider
 * could not stop ANOTHER session, a subagent child, or its own next
 * tool-result continuation from firing a provider request <1s later — the
 * observed 70k-token Cerebras failure (429 → "cooldown declared" → 429 again).
 * Cooldown must be EXECUTABLE STATE consulted before EVERY inference request,
 * shared across concurrent sessions/children, not prompt text.
 *
 * The store is a small file-locked JSON document (agent dir
 * `provider-health.json`, 0600) that any pi process — main session, subagent
 * child, auxiliary call — reads and writes through this module. The request
 * gate (extensions/provider-gate.ts, `before_provider_request`) is the
 * enforcement point; this module owns classification, cooldown math, and
 * pressure accounting.
 *
 * Failure classification (tracked independently, per the free-recovery audit:
 * two routes behind one provider are NOT one failure domain):
 *   quota-rate       429 / rate limit / too many requests / quota — shared
 *                    pool pressure; provider-scoped cooldown.
 *   provider-outage  503 / upstream_unavailable / service unavailable —
 *                    provider-scoped; failover to a compatible provider for
 *                    the same model is authorized (outage ≠ model failure).
 *   route-failure    gateway/upstream stream + transport failures (SSE
 *                    injection, stream_read_error, WebSocket, h2) —
 *                    route-scoped (provider+model).
 *   model-failure    upstream finish_reason: error, empty/no-actionable
 *                    content — route-scoped (that model misbehaved).
 *   deterministic    content moderation rejections — route-scoped; retry
 *                    loops fail fast on these already.
 *
 * Cooldown policy (user spec; retry-429-policy.mjs is the authority for the
 * fallback constant):
 *   * Retry-After / provider metadata wins when present (bounded at 10 min so
 *     a nonsensical header cannot freeze a route for hours).
 *   * Otherwise the FIXED 25s fallback (no exponential growth).
 *   * Token-aware pacing: a quota-rate failure on a LARGE request (>=16k
 *     estimated tokens) without Retry-After must not be resent immediately —
 *     the 70k-context loop resends ~70k tokens, which is exactly what token-
 *     rate limits reject. Pacing adds 5s per 10k tokens over the floor,
 *     bounded (never above 120s self-declared), plus a small bounded
 *     escalation for consecutive failures. Provider-supplied Retry-After is
 *     never inflated by pacing.
 *   * A successful response on the route/provider clears the cooldown (the
 *     success-clock reset, same semantics as the retry patch).
 *
 * Cross-process consistency: every mutation takes an exclusive mkdir lock
 * (stale takeover, same pattern as notify-broker.mjs). Reads are lock-free
 * best-effort — a torn/missing read degrades to "no state", which fails OPEN
 * for attribution (the gate never blocks a request it cannot classify) and
 * the next mutation re-anchors the file. Gate decisions RE-READ state every
 * poll so a sibling session's success/failure is observed within ~250ms.
 *
 * Test hooks: PI_PROVIDER_STATE_FILE overrides the store path; the gate
 * honors PI_PROVIDER_GATE=off and PI_PROVIDER_GATE_MAX_WAIT_MS.
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
// The cooldown FALLBACK and the cooldown-class regex are OWNED by
// scripts/patches/retry-429-policy.mjs (the policy authority). They are
// INLINED here — not imported — because sandboxed real-pi suites copy the
// pi-subagents fork STANDALONE (no extensions/lib, no scripts/), and any
// import outside extensions/pi-subagents breaks those child extension boots
// (subagent-model-ux / swarm-fusion-live). bench/provider-gate-test asserts
// the linkage (COOLDOWN_MS === 25000), so a policy change in the authority
// fails loudly here instead of drifting silently.
export const COOLDOWN_MS = 25_000;
/** Cooldown-class backstop: mirrors the policy authority's RATE_LIMIT_RE
 *  members (429/503 + rate-limit phrasing + unavailable + gateway/stream). */
export const RATE_LIMIT_RE: RegExp =
	/\b429\b|\b503\b|rate.?limit|too many requests|service.?unavailable|temporar(?:ily)? unavailable|upstream_unavailable|json error injected into sse stream|stream_read_error|finish_reason: error/i;

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Requests at or above this estimated token size engage token-aware pacing. */
export const TOKEN_PACING_MIN_TOKENS = 16_000;
/** Pacing added per 10k estimated tokens above the minimum (70k → +30s). */
export const TOKEN_PACING_STEP_MS = 5_000;
export const TOKEN_PACING_STEP_TOKENS = 10_000;
/** Hard ceiling for SELF-declared (non-Retry-After) cooldowns. */
export const SELF_COOLDOWN_CAP_MS = 120_000;
/** Bounded escalation per additional consecutive failure without metadata. */
export const CONSECUTIVE_ESCALATION_MS = 10_000;
export const CONSECUTIVE_ESCALATION_CAP_MS = 30_000;
/** Deterministic rejections: short route-level hold (retry loops fail fast anyway). */
export const DETERMINISTIC_COOLDOWN_MS = 60_000;
/** Maximum in-gate defer: cooldowns longer than this are DENIED (rate-limit
 *  class) instead of silently stalling the request inside the send path. */
export const DEFAULT_MAX_IN_GATE_WAIT_MS = 90_000;
/** Poll cadence while deferring in-gate. */
export const GATE_POLL_MS = 250;
/** Provider-supplied Retry-After is honored up to this ceiling. */
export const RETRY_AFTER_CEILING_MS = 600_000;
/** Stale-lock takeover age (the critical section is a small JSON rewrite). */
const STALE_LOCK_MS = 15_000;
/** Pressure-window shape: requests remembered per provider for pacing. */
const WINDOW_MAX_ENTRIES = 32;
const WINDOW_MAX_AGE_MS = 10 * 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureKind =
	| "quota-rate"
	| "provider-outage"
	| "route-failure"
	| "model-failure"
	| "deterministic";
export type FailureScope = "provider" | "route";

export interface FailureClassification {
	kind: FailureKind;
	scope: FailureScope;
	/** Retry-After-style hint parsed from the message; null when absent. */
	retryAfterMs: number | null;
}

export interface FailureRecord {
	kind: FailureKind;
	at: number;
	source: string;
	detail?: string;
	consecutive: number;
}

/** Bind observations to pricing and endpoint without storing credential-bearing URLs. */
export function economyRateIdentity(cost: {input?:number;output?:number;cacheRead?:number;cacheWrite?:number;tiers?:unknown}, baseUrl?:string, api?:string): string {
 return createHash('sha256').update(JSON.stringify([cost.input,cost.output,cost.cacheRead,cost.cacheWrite,cost.tiers??[],baseUrl??"",api??""])).digest('hex');
}

export interface EconomyUsageSample {
 at: number;
 messageAt?: number;
 /** Whole response duration only when exactly one attributable request was pending. */
 elapsedMs?: number;
 input: number;
 output: number;
 cacheRead: number;
 cacheWrite: number;
 costUsd: number;
 /** Exact rates used to price this route, serialized by the producer. */
 rates: string;
}
export interface ModelHealth {
 /** Last fifty SDK-reported successful usages and estimated costs; never semantic quality labels. */
 economyUsage?: EconomyUsageSample[];

	updatedAt: number;
	cooldownUntil: number;
	failure?: FailureRecord;
}

export interface RequestSample {
	at: number;
	estTokens: number;
}

export interface ProviderHealthEntry {
	updatedAt: number;
	cooldownUntil: number;
	/** Source of the active provider-level cooldown, e.g. "message_end:quota-rate". */
	cooldownSource?: string;
	failure?: FailureRecord;
	/** Route-level (provider+model) state — a route failure never cools the provider. */
	models: Record<string, ModelHealth>;
	/** Observed request pressure (bounded sliding window). */
	requests: RequestSample[];
	lastResult?: { at: number; ok: boolean; inputTokens?: number; errorMessage?: string };
	observed?: { retryAfterMs?: number; at?: number };
}

export interface PendingContinuation {
	route: string;
	reason: string;
	since: number;
	until: number;
	session?: string;
	kind?: FailureKind;
	source?: string;
}

export interface ProviderHealthState {
	version: 1;
	updatedAt: number;
	providers: Record<string, ProviderHealthEntry>;
	/** Continuations currently deferred by the gate (observability; cleared on allow). */
	pending: PendingContinuation[];
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Parse a Retry-After-style hint into milliseconds. Same accepted forms as
 * quota-health.ts (mirrored here for the top-level extensions): header echoes
 * ("Retry-After: 120"), prose ("try again in 8s"), bare seconds ("45").
 * Returns null when absent or unparseable — never throws.
 */
export function parseRetryAfterMs(detail: string | undefined | null, now = Date.now()): number | null {
	if (typeof detail !== "string") return null;
	const text = detail.trim().slice(0, 8192);
	const header = text.match(/retry[- ]?after\s*[:=]\s*([^\r\n]+)/i)?.[1]?.trim();
	// HTTP-date values must not be read as their day-of-month in seconds.
	if (header && /^[A-Za-z]{3},/.test(header)) {
		const date = Date.parse(header);
		return Number.isFinite(date) ? Math.max(0, date - now) : null;
	}
	const prose = text.match(/\b(?:retry|try)\s+(?:again\s+)?(?:in|after)\s+(.+)/i)?.[1];
	if (!header && !prose && !/^\d+(?:\.\d+)?\s*(?:milliseconds?|ms|minutes?|mins?|m|seconds?|secs?|s)?$/i.test(text)) return null;
	const value = header ?? prose ?? text;
	const match = value.match(/^(\d+(?:\.\d+)?)\s*(milliseconds?|ms|minutes?|mins?|m|seconds?|secs?|s)?(?=$|[\s,;.)])/i);
	if (!match) return null;
	const unit = match[2]?.toLowerCase() ?? "s";
	const scale = unit === "ms" || unit.startsWith("millisecond") ? 1 : unit === "m" || unit.startsWith("min") ? 60_000 : 1000;
	const ms = Number(match[1]) * scale;
	return Number.isFinite(ms) ? Math.round(ms) : null;
}

const QUOTA_RATE_RE =
	/\b429\b|rate.?limit|too many requests|quota|usage limit|insufficient_quota|out of budget|billing/i;
const PROVIDER_OUTAGE_RE =
	/\b503\b|service.?unavailable|temporar(?:ily)? unavailable|upstream_unavailable|upstream.{0,24}unavailable|provider.{0,24}unavailable/i;
const ROUTE_TRANSPORT_RE =
	/json error injected into sse stream|stream_read_error|websocket error|h2 protocol error|gateway|bad gateway|\b50[024]\b|\b529\b|\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|fetch failed|socket hang up|connection (?:reset|closed)|request timed out|overloaded/i;
const MODEL_FAILURE_RE =
	/finish_reason: error|no actionable content|empty(?:\/thinking-only)? response/i;
const DETERMINISTIC_RE =
	/data_inspection_failed|inappropriate content|content inspection|content filter|content moderation/i;

/**
 * Classify a provider error message into the independently-tracked failure
 * kinds. Order matters: deterministic rejections are identified first (they
 * must not be mistaken for rate pressure), then quota, then outage, then
 * model failures, then transport. Unknown messages return undefined — the
 * gate never blocks on text it cannot attribute.
 */
export function classifyFailure(errorMessage: string | undefined | null): FailureClassification | undefined {
	const text = typeof errorMessage === "string" ? errorMessage : "";
	if (!text) return undefined;
	// The gate's own denial message must never be re-recorded as a provider
	// failure (it would extend the very cooldown the gate is waiting on).
	if (text.includes("provider-gate")) return undefined;
	const retryAfterMs = parseRetryAfterMs(text);
	if (DETERMINISTIC_RE.test(text)) return { kind: "deterministic", scope: "route", retryAfterMs };
	if (QUOTA_RATE_RE.test(text)) return { kind: "quota-rate", scope: "provider", retryAfterMs };
	if (PROVIDER_OUTAGE_RE.test(text)) return { kind: "provider-outage", scope: "provider", retryAfterMs };
	if (MODEL_FAILURE_RE.test(text)) return { kind: "model-failure", scope: "route", retryAfterMs };
	if (ROUTE_TRANSPORT_RE.test(text)) return { kind: "route-failure", scope: "route", retryAfterMs };
	// Backstop: the policy authority's cooldown-class regex (covers any
	// phrasing the specific patterns above miss but the retry loop cools on).
	if (RATE_LIMIT_RE.test(text)) return { kind: "quota-rate", scope: "provider", retryAfterMs };
	return undefined;
}

/** Provider metadata wins; otherwise pace large quota requests and bounded repeats. */
export function cooldownFor(
 classification: FailureClassification,
 estTokens: number | undefined,
 consecutive: number,
): number {
 if (classification.kind === "deterministic") return DETERMINISTIC_COOLDOWN_MS;
 const hint = classification.retryAfterMs;
 if (typeof hint === "number" && Number.isFinite(hint) && hint >= 0)
  return Math.min(RETRY_AFTER_CEILING_MS, hint);
 const pacing = classification.kind === "quota-rate" && Number.isFinite(estTokens) && estTokens! >= TOKEN_PACING_MIN_TOKENS
  ? Math.ceil((estTokens! - TOKEN_PACING_MIN_TOKENS) / TOKEN_PACING_STEP_TOKENS) * TOKEN_PACING_STEP_MS
  : 0;
 const repeats = Number.isFinite(consecutive) ? Math.max(0, Math.floor(consecutive) - 1) : 0;
 const escalation = Math.min(CONSECUTIVE_ESCALATION_CAP_MS, repeats * CONSECUTIVE_ESCALATION_MS);
 return Math.min(SELF_COOLDOWN_CAP_MS, COOLDOWN_MS + pacing + escalation);
}

// ---------------------------------------------------------------------------
// Store I/O (locked mutate, tolerant read)
// ---------------------------------------------------------------------------

export function agentHealthDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	if (configured === "~") return home;
	if (configured?.startsWith("~/") || configured?.startsWith("~\\")) {
		return path.join(home, configured.slice(2));
	}
	return configured || path.join(home, ".pi", "agent");
}

export function healthFilePath(): string {
	return process.env.PI_PROVIDER_STATE_FILE || path.join(agentHealthDir(), "provider-health.json");
}

function emptyState(): ProviderHealthState {
	return { version: 1, updatedAt: 0, providers: Object.create(null), pending: [] };
}

function validEntry(value: unknown): value is ProviderHealthEntry {
	if (!value || typeof value !== "object") return false;
	const e = value as Partial<ProviderHealthEntry>;
	return (
		Number.isFinite(e.updatedAt) &&
		Number.isFinite(e.cooldownUntil) &&
		(e.cooldownUntil as number) >= 0 &&
		typeof e.models === "object" &&
		e.models !== null &&
		Array.isArray(e.requests)
	);
}

/** Tolerant read: missing/corrupt state reads as empty (fail-open attribution). */
export function readHealth(): ProviderHealthState {
	try {
		const parsed = JSON.parse(fs.readFileSync(healthFilePath(), "utf8"));
		if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return emptyState();
		const providers: Record<string, ProviderHealthEntry> = Object.create(null);
		for (const [provider, entry] of Object.entries(parsed.providers ?? {})) {
			if (validEntry(entry)) providers[provider] = {
				...entry,
				models: Object.assign(Object.create(null), Object.fromEntries(Object.entries(entry.models).filter(([, model]) => model && Number.isFinite(model.updatedAt) && Number.isFinite(model.cooldownUntil) && model.cooldownUntil >= 0))),
				requests: entry.requests.filter(sample => sample && Number.isFinite(sample.at) && Number.isFinite(sample.estTokens) && sample.estTokens >= 0).slice(-WINDOW_MAX_ENTRIES),
			};
		}
		const pending = Array.isArray(parsed.pending)
			? (parsed.pending as PendingContinuation[]).filter(
					(p) =>
						p &&
						typeof p.route === "string" &&
						typeof p.reason === "string" &&
						typeof p.since === "number" &&
						typeof p.until === "number",
				)
			: [];
		return { version: 1, updatedAt: parsed.updatedAt ?? 0, providers, pending };
	} catch {
		return emptyState();
	}
}

/**
 * Exclusive mkdir lock with stale takeover (same discipline as
 * notify-broker.mjs). Returns the release function.
 */
function acquireLock(lockDir: string): () => void {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			fs.mkdirSync(lockDir);
			return () => {
				try {
					fs.rmSync(lockDir, { recursive: true, force: true });
				} catch {
					/* best effort */
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// A lock older than STALE_LOCK_MS is dead: the critical section is a
			// read-modify-write of a small JSON file, never a long operation.
			try {
				if (Date.now() - fs.statSync(lockDir).mtimeMs > STALE_LOCK_MS) {
					fs.rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				// A disappearing lock is transient, but a persistent stat error must
				// still honor the acquisition deadline instead of spinning forever.
				if (Date.now() > deadline) {
					throw new Error(`provider-health: state lock timeout (${LOCK_TIMEOUT_MS}ms): ${lockDir}`);
				}
				continue; // lock vanished between stat and rm — retry
			}
			if (Date.now() > deadline) {
				throw new Error(`provider-health: state lock timeout (${LOCK_TIMEOUT_MS}ms): ${lockDir}`);
			}
			const spinUntil = Date.now() + LOCK_POLL_MS;
			while (Date.now() < spinUntil) {
				/* bounded wait, keeps the critical section tight */
			}
		}
	}
}

/** Locked read-modify-write; persists atomically (tmp+rename, 0600). */
export function mutateHealth<T>(mutator: (state: ProviderHealthState) => T): T {
	const file = healthFilePath();
	const lockDir = `${file}.lock`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const release = acquireLock(lockDir);
	try {
		const state = readHealth();
		const result = mutator(state);
		state.updatedAt = Date.now();
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
		fs.renameSync(tmp, file);
		return result;
	} finally {
		release();
	}
}

// ---------------------------------------------------------------------------
// Recording (request pressure, failures, successes)
// ---------------------------------------------------------------------------

function pruneWindow(entry: ProviderHealthEntry, now: number): void {
	entry.requests = entry.requests
		.filter((r) => now - r.at <= WINDOW_MAX_AGE_MS)
		.slice(-WINDOW_MAX_ENTRIES);
}

function ensureEntry(state: ProviderHealthState, provider: string, now: number): ProviderHealthEntry {
	const existing = state.providers[provider];
	if (existing && validEntry(existing)) return existing;
	const entry: ProviderHealthEntry = { updatedAt: now, cooldownUntil: 0, models: Object.create(null), requests: [] };
	state.providers[provider] = entry;
	return entry;
}

export interface RecordRequestInput {
	provider: string;
	model?: string;
	estTokens?: number;
	now?: number;
}

/** Record an outgoing request in the provider's pressure window. */
export function recordRequest(input: RecordRequestInput): void {
	const now = input.now ?? Date.now();
	mutateHealth((state) => {
		const entry = ensureEntry(state, input.provider, now);
		entry.updatedAt = now;
		entry.requests.push({ at: now, estTokens: Math.max(0, Math.round(input.estTokens ?? 0)) });
		pruneWindow(entry, now);
	});
}

export interface RecordFailureInput {
	provider: string;
	model?: string;
	/** Raw provider/turn error text; classified internally. */
	errorMessage?: string;
	/** Where the failure was observed (observability), e.g. "message_end". */
	source?: string;
	/** Estimated request size; when omitted, the route's newest request sample is used. */
	estTokens?: number;
	now?: number;
}

export interface RecordedFailure {
	kind: FailureKind;
	scope: FailureScope;
	cooldownUntil: number;
	consecutive: number;
}

/**
 * Record a classified provider failure and declare the executable cooldown.
 * Route-scoped kinds cool only that (provider, model) pair; provider-scoped
 * kinds cool the whole provider entry (shared pool / outage semantics).
 * Unattributable messages are ignored (never block on unknown text).
 */
export function recordFailure(input: RecordFailureInput): RecordedFailure | undefined {
	const now = input.now ?? Date.now();
	const classification = classifyFailure(input.errorMessage);
	if (!classification) return undefined;
	return mutateHealth((state) => {
		const entry = ensureEntry(state, input.provider, now);
		entry.updatedAt = now;
		const routeKey = input.model ?? "";
		const routeState =
			routeKey && entry.models[routeKey]
				? entry.models[routeKey]
				: routeKey
					? (entry.models[routeKey] = { updatedAt: now, cooldownUntil: 0 })
					: undefined;
		const priorConsecutive =
			(classification.scope === "provider" ? entry.failure?.consecutive : routeState?.failure?.consecutive) ?? 0;
		const consecutive = (now - (classification.scope === "provider" ? entry.failure?.at ?? 0 : routeState?.failure?.at ?? 0) <= WINDOW_MAX_AGE_MS
			? priorConsecutive
			: 0) + 1;
		const estTokens =
			typeof input.estTokens === "number"
				? input.estTokens
				: entry.requests.length
					? entry.requests[entry.requests.length - 1]!.estTokens
					: undefined;
		const cooldownMs = cooldownFor(classification, estTokens, consecutive);
		const cooldownUntil = now + cooldownMs;
		const record: FailureRecord = {
			kind: classification.kind,
			at: now,
			source: input.source ?? "unknown",
			...(input.errorMessage ? { detail: input.errorMessage.slice(0, 500) } : {}),
			consecutive,
		};
		if (classification.scope === "provider") {
            for (const model of Object.values(entry.models)) model.economyUsage = undefined;
			entry.failure = record;
			entry.cooldownUntil = cooldownUntil;
			entry.cooldownSource = `${record.source}:${classification.kind}`;
		} else if (routeState) {
            routeState.economyUsage = undefined;
			routeState.failure = record;
			routeState.cooldownUntil = cooldownUntil;
			routeState.updatedAt = now;
		}
		if (classification.retryAfterMs !== null) {
			entry.observed = { retryAfterMs: classification.retryAfterMs, at: now };
		}
		entry.lastResult = { at: now, ok: false, ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 300) } : {}) };
		pruneWindow(entry, now);
		return {
			kind: classification.kind,
			scope: classification.scope,
			cooldownUntil,
			consecutive,
		};
	});
}

/** A protocol error can revoke economic evidence even when cooldown classification is unknown. */
export function invalidateEconomyUsage(provider:string, model?:string): void {
 mutateHealth(state=>{
  const entry=state.providers[provider];
  if(!entry)return;
  if(model) {if(entry.models[model])entry.models[model].economyUsage=undefined;}
  else for(const route of Object.values(entry.models))route.economyUsage=undefined;
 });
}

export interface RecordSuccessInput {
	provider: string;
	model?: string;
	inputTokens?: number;
 economyUsage?: Omit<EconomyUsageSample, "at">;
	now?: number;
}

/**
 * Record a successful response: clears the route's cooldown (and the
 * provider's, when the success carries no explicit contradiction) and resets
 * the consecutive counter — success is the recovery evidence, mirroring the
 * retry patch's success-clock reset.
 */
export function recordSuccess(input: RecordSuccessInput): void {
	const now = input.now ?? Date.now();
	mutateHealth((state) => {
		const entry = ensureEntry(state, input.provider, now);
        if (input.model && !entry.models[input.model]) entry.models[input.model] = {updatedAt:now, cooldownUntil:0};
		entry.updatedAt = now;
		entry.lastResult = {
			at: now,
			ok: true,
			...(typeof input.inputTokens === "number" ? { inputTokens: Math.round(input.inputTokens) } : {}),
		};
		entry.failure = undefined;
		entry.cooldownUntil = 0;
		entry.cooldownSource = undefined;
		if (input.model && entry.models[input.model]) {
			const model = entry.models[input.model]!;
			model.cooldownUntil = 0;
			model.failure = undefined;
			model.updatedAt = now;
            const usage = input.economyUsage;
            if (usage && [usage.input,usage.output,usage.cacheRead,usage.cacheWrite].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100_000_000)
                && Number.isFinite(usage.costUsd) && usage.costUsd>=0 && typeof usage.rates === "string" && usage.rates.length<=2048) {
                const previous = Array.isArray(model.economyUsage) ? model.economyUsage : [];
                const observedAt = usage.messageAt ?? now;
                if (!Number.isFinite(observedAt) || observedAt>now || now-observedAt>300_000) {model.economyUsage=undefined;return;}
                model.economyUsage = [...previous.filter(sample=>sample && sample.rates===usage.rates && sample.at<=now && now-sample.at<=300_000 && (usage.messageAt===undefined || sample.messageAt!==usage.messageAt)), {...usage,at:observedAt}].slice(-50);
            } else model.economyUsage = undefined;
		}
	});
}

// ---------------------------------------------------------------------------
// Evaluation + the gate step
// ---------------------------------------------------------------------------

export interface RouteDecision {
	allowed: boolean;
	/** ms until eligible when not allowed; 0 otherwise. */
	waitMs: number;
	cooldownUntil: number;
	kind?: FailureKind;
	source?: string;
	consecutive?: number;
	/** "provider" or "route" — which cooldown is binding. */
	boundBy?: FailureScope;
}

/** Resolve the executable state for one route right now (read-only). */
export function evaluateRoute(input: { provider: string; model?: string; now?: number }): RouteDecision {
	const now = input.now ?? Date.now();
	const entry = readHealth().providers[input.provider];
	if (!entry) return { allowed: true, waitMs: 0, cooldownUntil: 0 };
	// Persisted deadlines already include metadata/pacing; do not shorten them
	// to the fallback when another process evaluates the route.
	const providerUntil = entry.cooldownUntil;
	const routeUntil = (input.model ? entry.models[input.model]?.cooldownUntil : 0) ?? 0;
	const until = Math.max(providerUntil, routeUntil);
	if (until <= now) return { allowed: true, waitMs: 0, cooldownUntil: until };
	const byProvider = providerUntil >= routeUntil;
	const record = byProvider ? entry.failure : input.model ? entry.models[input.model]?.failure : undefined;
	return {
		allowed: false,
		waitMs: until - now,
		cooldownUntil: until,
		...(record?.kind !== undefined ? { kind: record.kind } : {}),
		...(record?.source !== undefined ? { source: record.source } : {}),
		...(record?.consecutive !== undefined ? { consecutive: record.consecutive } : {}),
		boundBy: byProvider ? "provider" : "route",
	};
}

/** Estimated token count for a request payload (chars/4, bounded scan). */
export function estimateTokens(payload: unknown): number {
	try {
		const json = JSON.stringify(payload?.["messages"] ?? payload ?? "");
		return Math.ceil(json.length / 4);
	} catch {
		return 0;
	}
}

export interface GateRequestInput {
	provider: string;
	model?: string;
	estTokens?: number;
	/** Identifier of the deferred continuation (session file / purpose). */
	session?: string;
	/** Total in-gate wait budget; cooldowns longer than this are denied. */
	maxWaitMs?: number;
	signal?: AbortSignal;
	now?: number;
	sleep?: (ms: number) => Promise<void>;
}

export interface GateOutcome {
	allowed: boolean;
	/** Deferred ms before the allow (0 when immediately allowed). */
	deferredMs: number;
	decision?: RouteDecision;
}

export class GateDeniedError extends Error {
	code = "PI_AUTONOMOUS_REQUEST_DENIED";
	details: RouteDecision;
	constructor(message: string, details: RouteDecision) {
		super(message);
		this.name = "GateDeniedError";
		this.details = details;
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithSignal(ms: number, signal: AbortSignal | undefined, sleep: (ms: number) => Promise<void>): Promise<void> {
	if (!signal) return sleep(ms);
	if (signal.aborted) return Promise.reject(new Error("Aborted"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * THE pre-send gate step (used by extensions/provider-gate.ts and tests):
 *
 *   1. record request pressure (shared, so sibling processes see it),
 *   2. evaluate executable cooldown state for the route,
 *   3. when cooling and the remaining cooldown fits the in-gate budget:
 *      DEFER — hold the request in place (polling shared state so a sibling
 *      session's success/failure is observed), preserving the pending
 *      continuation in the store for inspection, then allow the SAME request,
 *   4. when cooling longer than the budget: DENY by throwing GateDeniedError
 *      carrying `PI_AUTONOMOUS_REQUEST_DENIED` (the patched request seam
 *      re-throws it, so the provider is never called) and a rate-limit-class
 *      message (the cooldown-class retry machinery then owns the longer wait:
 *      fixed 25s between re-requests, 2-min budget, pause-with-note).
 *
 * ZERO provider calls happen while a cooling state binds — the allow returns
 * only after eligibility.
 */
export async function gateRequest(input: GateRequestInput): Promise<GateOutcome> {
	input.signal?.throwIfAborted();
	const now = input.now ?? Date.now();
	recordRequest({ provider: input.provider, model: input.model, estTokens: input.estTokens, now });
	let decision = evaluateRoute({ provider: input.provider, model: input.model, now });
	if (decision.allowed) {
		clearPending(`${input.provider}/${input.model ?? ""}`, input.session);
		return { allowed: true, deferredMs: 0 };
	}
	const maxWaitMs = input.maxWaitMs ?? resolveMaxWaitMs();
	const route = `${input.provider}/${input.model ?? ""}`;
	if (decision.waitMs > maxWaitMs) {
		denyPending(route, decision, input.session);
		throw new GateDeniedError(
			`429 rate limit: provider-gate deferral for ${route} — cooldown-active ${Math.ceil(decision.waitMs / 1000)}s` +
				` (kind: ${decision.kind ?? "unknown"}, source: ${decision.source ?? "unknown"}, bound: ${decision.boundBy ?? "unknown"};` +
				` state: provider-health.json)`,
			decision,
		);
	}
	const sleep = input.sleep ?? defaultSleep;
	const startedAt = now;
	markPending(route, decision, input.session);
	try {
		for (;;) {
			await sleepWithSignal(Math.min(GATE_POLL_MS, decision.waitMs), input.signal, sleep);
			input.signal?.throwIfAborted();
			const now2 = Date.now();
			decision = evaluateRoute({ provider: input.provider, model: input.model, now: now2 });
			if (decision.allowed) {
				clearPending(route, input.session);
				return { allowed: true, deferredMs: now2 - startedAt };
			}
			if (now2 - startedAt + decision.waitMs > maxWaitMs) {
				denyPending(route, decision, input.session);
				throw new GateDeniedError(
					`429 rate limit: provider-gate deferral for ${route} — cooldown-active ${Math.ceil(decision.waitMs / 1000)}s` +
						` (kind: ${decision.kind ?? "unknown"}, source: ${decision.source ?? "unknown"}, bound: ${decision.boundBy ?? "unknown"};` +
						` state: provider-health.json)`,
					decision,
				);
			}
		}
	} catch (err) {
		// Cancellation while deferring: drop the pending marker, rethrow.
		if (!(err instanceof GateDeniedError)) clearPending(route, input.session);
		throw err;
	}
}

function resolveMaxWaitMs(): number {
	const raw = Number(process.env.PI_PROVIDER_GATE_MAX_WAIT_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_IN_GATE_WAIT_MS;
}

// ---------------------------------------------------------------------------
// Pending-continuation bookkeeping (observability: inspectable, not prose)
// ---------------------------------------------------------------------------

function markPending(route: string, decision: RouteDecision, session?: string): void {
	mutateHealth((state) => {
		state.pending = state.pending.filter((p) => p.route !== route || p.session !== session);
		state.pending.push({
			route,
			reason: "cooldown-active",
			since: Date.now(),
			until: decision.cooldownUntil,
			...(session ? { session } : {}),
			...(decision.kind !== undefined ? { kind: decision.kind } : {}),
			...(decision.source !== undefined ? { source: decision.source } : {}),
		});
		state.pending = state.pending.slice(-16);
		return undefined;
	});
}

function clearPending(route: string, session?: string): void {
	// Healthy requests ordinarily have no pending continuation. Avoid a second
	// locked rewrite after pressure recording when cleanup would change nothing.
	if (!readHealth().pending.some((p) => p.route === route && p.session === session)) return;
	mutateHealth((state) => {
		state.pending = state.pending.filter((p) => p.route !== route || p.session !== session);
		return undefined;
	});
}

function denyPending(route: string, decision: RouteDecision, session?: string): void {
	// A denial hands the wait back to the cooldown-class retry machinery; keep
	// a pending marker with the DENIED reason so the deferral stays inspectable.
	mutateHealth((state) => {
		state.pending = state.pending.filter((p) => p.route !== route || p.session !== session);
		state.pending.push({
			route,
			reason: "denied-beyond-gate-budget",
			since: Date.now(),
			until: decision.cooldownUntil,
			...(session ? { session } : {}),
			...(decision.kind !== undefined ? { kind: decision.kind } : {}),
			...(decision.source !== undefined ? { source: decision.source } : {}),
		});
		state.pending = state.pending.slice(-16);
		return undefined;
	});
}

// ---------------------------------------------------------------------------
// Observability snapshot
// ---------------------------------------------------------------------------

export interface HealthSnapshot {
	file: string;
	updatedAt: number;
	providers: Array<{
		provider: string;
		cooldownUntil: number;
		cooldownSource?: string;
		failure?: FailureRecord;
		lastResult?: ProviderHealthEntry["lastResult"];
		observed?: ProviderHealthEntry["observed"];
		requestsLast60s: number;
		estTokensLast60s: number;
		models: Array<{ model: string; cooldownUntil: number; failure?: FailureRecord }>;
	}>;
	pending: PendingContinuation[];
}

/** One bounded, human-inspectable view of the shared state. */
export function snapshot(now = Date.now()): HealthSnapshot {
	const state = readHealth();
	return {
		file: healthFilePath(),
		updatedAt: state.updatedAt,
		providers: Object.entries(state.providers).map(([provider, entry]) => {
			const recent = entry.requests.filter((r) => now - r.at <= 60_000);
			return {
				provider,
				cooldownUntil: entry.cooldownUntil,
				...(entry.cooldownSource !== undefined ? { cooldownSource: entry.cooldownSource } : {}),
				...(entry.failure !== undefined ? { failure: entry.failure } : {}),
				...(entry.lastResult !== undefined ? { lastResult: entry.lastResult } : {}),
				...(entry.observed !== undefined ? { observed: entry.observed } : {}),
				requestsLast60s: recent.length,
				estTokensLast60s: recent.reduce((sum, r) => sum + r.estTokens, 0),
				models: Object.entries(entry.models).map(([model, m]) => ({
					model,
					cooldownUntil: m.cooldownUntil,
					...(m.failure !== undefined ? { failure: m.failure } : {}),
				})),
			};
		}),
		pending: state.pending,
	};
}
