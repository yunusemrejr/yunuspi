/**
 * Deterministic fan-out degradation recovery planner (2026-09-06 pass).
 *
 * INPUT  : run records for a swarm fan-out plus a recovery config.
 * OUTPUT : which children degraded, and a bounded, scheduled respawn plan.
 *
 * Attempt accounting (1-based):
 *   - the ORIGINAL run of a work item is its unsuffixed key ("swarm") and has
 *     made 0 attempts so far;
 *   - a key "swarm-attempt-N" represents the N-th attempt having already run;
 *   - the next respawn is "swarm-attempt-(N+1)" with entry attempt === N+1;
 *   - a family is NEVER rescheduled once its newest attempt satisfies
 *     N >= config.maxRespawnRounds (that key's rounds are used up).
 *
 * Families: records sharing the same base key (with any "-attempt-N" suffix
 * stripped) belong to one work item. Only the NEWEST attempt (highest attempt
 * number; on ties the later record in input order, inputs assumed
 * chronological) decides whether the family reschedules — a family whose
 * newest attempt completed is healthy even if an older attempt failed.
 *
 * Scheduling: a respawn scheduled at entry attempt A is gated behind
 *   now + min(config.baseBackoffMs * 2**(A-1), BACKOFF_CAP_MS)
 * i.e. an exponential backoff curve (base, 2x, 4x, ...) capped at 60s.
 *
 * Contract: pure logic — injected records/clock, no timers, no network, no
 * tool imports. Any malformed field fails LOUDLY with a TypeError that names
 * the offending field. No silent tolerance.
 */

export const SWARM_RUN_STATUSES: readonly string[] = [
	"completed",
	"error",
	"timeout",
	"budget-exhausted",
	"running",
	"stopped",
];

export const BACKOFF_CAP_MS = 60_000;

export interface SwarmRecoveryConfig {
	/** Maximum respawn rounds per work item (the original run does not count). */
	maxRespawnRounds: number;
	/** Base backoff in ms; attempt N waits baseBackoffMs * 2**(N-1), capped. */
	baseBackoffMs: number;
}

export interface SwarmRunRecord {
	/** Unique run key. A "-attempt-N" suffix marks attempt N of the base item. */
	key: string;
	status: "completed" | "error" | "timeout" | "budget-exhausted" | "running" | "stopped";
	/** Epoch ms. */
	startedAt: number;
	/** Epoch ms, present when the run ended. */
	endedAt?: number;
	tokens?: number;
}

export interface SwarmRespawn {
	/** Key the respawn must run under ("base-attempt-(next)"); never collides across plan entries. */
	key: string;
	/** 1-based respawn attempt number. */
	attempt: number;
	/** Epoch ms before which the respawn must not be launched. */
	notBeforeMs: number;
}

export interface SwarmRecoveryResult {
	/** Every record key observed with a degraded status, unique, input order. */
	degraded: string[];
	/** Deterministically sorted (by key) respawn entries for degraded families. */
	respawnPlan: SwarmRespawn[];
}

export const DEFAULT_CONFIG: SwarmRecoveryConfig = {
	maxRespawnRounds: 3,
	baseBackoffMs: 5_000,
};

const DEGRADED_STATUSES: ReadonlySet<string> = new Set(["error", "timeout", "budget-exhausted"]);
const ATTEMPT_SUFFIX: RegExp = /^(.*)-attempt-(\d+)$/;

export function planSwarmRecovery(
	records: SwarmRunRecord[] = [],
	config: SwarmRecoveryConfig = DEFAULT_CONFIG,
	now: number = 0,
): SwarmRecoveryResult {
	validateConfig(config);
	if (!Array.isArray(records)) {
		throw new TypeError("records must be an array of run records");
	}
	for (let i = 0; i < records.length; i++) {
		validateRecord(records[i], i);
	}
	if (typeof now !== "number" || !Number.isFinite(now)) {
		throw new TypeError(`now must be a finite epoch-ms number, got ${JSON.stringify(now)}`);
	}

	const degraded: string[] = [];
	const cancelled = new Set<string>();
	const families = new Map<string, { base: string; latestAttempt: number; record: SwarmRunRecord }>();

	records.forEach((record, index) => {
		const match = record.key.match(ATTEMPT_SUFFIX);
		const base = match ? match[1] : record.key;
		const attempt = match ? Number(match[2]) : 0;
		if (!Number.isSafeInteger(attempt)) throw new TypeError("attempt suffix exceeds safe integer range");
		if (match && attempt < 1) throw new TypeError(`record[${index}].key attempt suffix must be >= 1`);
		if (record.status === "stopped") cancelled.add(base);
		if (DEGRADED_STATUSES.has(record.status) && !degraded.includes(record.key)) {
			degraded.push(record.key);
		}
		const prev = families.get(base);
		if (!prev || attempt >= prev.latestAttempt) {
			families.set(base, { base, latestAttempt: attempt, record });
		}
		// index is part of the deterministic tie-break (later record wins equal attempts).
		void index;
	});

	const plan: SwarmRespawn[] = [];
	for (const state of families.values()) {
		if (!DEGRADED_STATUSES.has(state.record.status) || cancelled.has(state.base)) continue;
		// A consumed budget is not a transient provider failure; do not mint another one.
		if (state.record.status === "budget-exhausted") continue;
		if (state.latestAttempt >= config.maxRespawnRounds) continue; // rounds used up
		const attempt = state.latestAttempt + 1;
		const delayMs = Math.min(config.baseBackoffMs * 2 ** state.latestAttempt, BACKOFF_CAP_MS);
		plan.push({ key: `${state.base}-attempt-${attempt}`, attempt, notBeforeMs: now + delayMs });
	}
	plan.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

	return { degraded, respawnPlan: plan };
}

function validateConfig(config: SwarmRecoveryConfig): void {
	if (config === null || typeof config !== "object" || Array.isArray(config)) {
		throw new TypeError("config must be an object with maxRespawnRounds and baseBackoffMs");
	}
	if (!Number.isInteger(config.maxRespawnRounds) || config.maxRespawnRounds < 1) {
		throw new TypeError(`config.maxRespawnRounds must be an integer >= 1, got ${JSON.stringify(config.maxRespawnRounds)}`);
	}
	if (typeof config.baseBackoffMs !== "number" || !Number.isFinite(config.baseBackoffMs) || config.baseBackoffMs < 0) {
		throw new TypeError(`config.baseBackoffMs must be a finite number >= 0, got ${JSON.stringify(config.baseBackoffMs)}`);
	}
}

function validateRecord(record: unknown, index: number): void {
	if (record === null || typeof record !== "object" || Array.isArray(record)) {
		throw new TypeError(`record[${index}] must be an object, got ${JSON.stringify(record)}`);
	}
	const r = record as Record<string, unknown>;
	if (typeof r.key !== "string" || r.key.length === 0) {
		throw new TypeError(`record[${index}].key must be a non-empty string, got ${JSON.stringify(r.key)}`);
	}
	if (typeof r.status !== "string" || !(SWARM_RUN_STATUSES as readonly string[]).includes(r.status)) {
		throw new TypeError(
			`record[${index}].status must be one of ${SWARM_RUN_STATUSES.join(", ")}, got ${JSON.stringify(r.status)}`,
		);
	}
	if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt)) {
		throw new TypeError(`record[${index}].startedAt must be a finite number, got ${JSON.stringify(r.startedAt)}`);
	}
	if (r.tokens !== undefined && (typeof r.tokens !== "number" || !Number.isFinite(r.tokens))) {
		throw new TypeError(`record[${index}].tokens must be a finite number when present, got ${JSON.stringify(r.tokens)}`);
	}
	if (r.endedAt !== undefined && (typeof r.endedAt !== "number" || !Number.isFinite(r.endedAt))) {
		throw new TypeError(`record[${index}].endedAt must be a finite number when present, got ${JSON.stringify(r.endedAt)}`);
	}
}
