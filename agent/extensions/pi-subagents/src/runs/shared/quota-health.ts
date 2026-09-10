// quota-health.ts — deterministic provider-quota state machine for the
// 2026-09-06 subagent quota-awareness pass.
//
// Pure logic: every function is a function of (events, providers, now) with an
// injected clock — no I/O, no timers, no env reads. Consumers (run budgeting,
// provider failover) feed in recent request outcomes; the module emits a
// per-provider health record.
//
// State model per provider, recomputed from scratch over the still-fresh
// events (events older than QUOTA_STALE_AFTER_MS are ignored, so state decays
// naturally as the window slides):
//   healthy -> throttled   on any throttled event (also a single
//                          quota-exhausted event — one hit is a warning, not
//                          exhaustion)
//   *       -> exhausted   on >=2 quota-exhausted events inside a rolling
//                          QUOTA_EXHAUST_WINDOW_MS window
//   *       -> healthy     on an ok event (explicit recovery) or when all
//                          state-causing events age out of the freshness window
//
// 'error' events are transport failures, not quota signals: they never change
// state. Exhausted never downgrades to throttled on a later throttled event —
// only ok/staleness clears it, so a provider under retry-After pressure is not
// probed again just because the client started throttling itself.

export type QuotaEventKind = "ok" | "throttled" | "quota-exhausted" | "error";

export interface QuotaEvent {
	provider: string;
	at: number;
	kind: QuotaEventKind;
	/** Optional Retry-After-like hint, e.g. "Retry-After: 120" or "45". */
	detail?: string;
}

export type QuotaState = "healthy" | "throttled" | "exhausted";

export interface QuotaHealth {
	provider: string;
	state: QuotaState;
	/** Epoch ms until which callers should hold back requests; null when healthy. */
	cooldownUntil: number | null;
	/** Provider-stated reset delay in ms, parsed from the newest state-causing event; null when absent/unparseable. */
	resetEtaMs: number | null;
}

export const QUOTA_STALE_AFTER_MS = 30 * 60 * 1000;
export const QUOTA_EXHAUST_WINDOW_MS = 10 * 60 * 1000;
export const QUOTA_THROTTLED_COOLDOWN_MS = 60 * 1000;
export const QUOTA_EXHAUSTED_COOLDOWN_MS = 5 * 60 * 1000;

const KNOWN_KINDS: ReadonlySet<string> = new Set<QuotaEventKind>([
	"ok",
	"throttled",
	"quota-exhausted",
	"error",
]);

function assertEvent(event: QuotaEvent, index: number): void {
	if (typeof event !== "object" || event === null) {
		throw new TypeError(`quota-health: events[${index}] must be an object`);
	}
	if (typeof event.provider !== "string" || event.provider.length === 0) {
		throw new TypeError(`quota-health: events[${index}].provider must be a non-empty string`);
	}
	if (typeof event.at !== "number" || !Number.isFinite(event.at)) {
		throw new TypeError(`quota-health: events[${index}].at must be a finite epoch-ms number`);
	}
	if (!KNOWN_KINDS.has(event.kind)) {
		throw new TypeError(
			`quota-health: events[${index}].kind "${String(event.kind)}" is not one of ok|throttled|quota-exhausted|error`,
		);
	}
}

/**
 * Parse a Retry-After-like hint into milliseconds. Accepts "Retry-After: 120",
 * "retry after 30s", or a bare "45" / "45 seconds". Returns null (never
 * throws) when absent or unparseable — a missing hint is a quiet signal, not
 * a contract violation.
 */
export function parseRetryAfterMs(detail: string | undefined): number | null {
	if (typeof detail !== "string") {
		return null;
	}
	const trimmed = detail.trim();
	if (trimmed.length === 0) {
		return null;
	}
	const named = trimmed.match(/retry-?\s*after\D*?(\d+(?:\.\d+)?)/i);
	const raw = named ? named[1] : /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?$/i.exec(trimmed)?.[1];
	if (raw === undefined) {
		return null;
	}
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0) {
		return null;
	}
	return Math.round(seconds * 1000);
}

/**
 * Health for one provider, recomputed from the fresh (non-stale) events for
 * that provider only. Events are processed in time order (ties keep input
 * order); unknown providers simply report healthy with no activity.
 */
export function evaluateProviderQuotaHealth(
	events: QuotaEvent[],
	provider: string,
	now: number,
): QuotaHealth {
	if (!Array.isArray(events)) {
		throw new TypeError("quota-health: events must be an array");
	}
	if (typeof provider !== "string" || provider.length === 0) {
		throw new TypeError("quota-health: provider must be a non-empty string");
	}
	if (typeof now !== "number" || !Number.isFinite(now)) {
		throw new TypeError("quota-health: now must be a finite epoch-ms number");
	}

	// Validate every event first so a malformed timestamp cannot be laundered
	// into a silent drop by the staleness filter below.
	events.forEach((event, index) => assertEvent(event, index));

	const eventsForProvider = events
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => event.provider === provider && now - event.at <= QUOTA_STALE_AFTER_MS)
		.sort((a, b) => (a.event.at - b.event.at) || (a.index - b.index));

	const exhaustTimes: number[] = [];
	let state: QuotaState = "healthy";
	/** Detail of the newest state-causing (throttled/exhausted) event. */
	let lastCauseDetail: string | undefined;

	for (const { event } of eventsForProvider) {
		switch (event.kind) {
			case "ok":
				state = "healthy";
				lastCauseDetail = undefined;
				break;
			case "error":
				// transport failure: no quota signal, state unchanged
				break;
			case "throttled":
				if (state !== "exhausted") {
					state = "throttled";
				}
				lastCauseDetail = event.detail;
				break;
			case "quota-exhausted": {
				const inWindow = exhaustTimes.filter((t) => event.at - t <= QUOTA_EXHAUST_WINDOW_MS).length + 1;
				exhaustTimes.push(event.at);
				state = inWindow >= 2 ? "exhausted" : state === "exhausted" ? "exhausted" : "throttled";
				lastCauseDetail = event.detail;
				break;
			}
		}
	}

	const health: QuotaHealth = {
		provider,
		state,
		cooldownUntil:
			state === "exhausted"
				? now + QUOTA_EXHAUSTED_COOLDOWN_MS
				: state === "throttled"
					? now + QUOTA_THROTTLED_COOLDOWN_MS
					: null,
		resetEtaMs: state === "healthy" ? null : parseRetryAfterMs(lastCauseDetail),
	};
	return health;
}

/**
 * Health for each named provider, in the given order. Unknown provider names
 * are reported healthy (no activity), so callers can enumerate a fleet.
 */
export function evaluateQuotaHealth(
	events: QuotaEvent[],
	providers: string[],
	now: number,
): QuotaHealth[] {
	if (!Array.isArray(providers)) {
		throw new TypeError("quota-health: providers must be an array");
	}
	return providers.map((provider) => evaluateProviderQuotaHealth(events, provider, now));
}