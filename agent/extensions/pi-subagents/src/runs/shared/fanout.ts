/**
 * Fan-out planners (pure, dependency-free): one module for the two deterministic
 * halves of a parallel run. Part 1 merges worker fragments with provenance and
 * visible conflicts; part 2 plans bounded, backed-off respawns for degraded
 * children. Any malformed field fails loudly with a TypeError naming it.
 */

// ── Part 1: provenance-preserving merge ────────────────────────────────────
/** A single fragment emitted by a fan-out worker. */
export type Fragment = {
	owner: string;
	kind: "duplicate" | "complementary" | "conflict";
	body: string;
	updatedAt: number;
};

/** Global merge strategy chosen from the fragment kinds present. */
export type MergeStrategy = "deduped" | "union" | "disjoint-split";

/** Provenance entry: which worker owns which fused section. */
export type MergeProvenance = {
	section: string;
	owner: string;
	/** UTF-16 character range of this source's retained body, excluding the truncation marker. */
	start: number;
	end: number;
	omitted?: boolean;
	truncated?: boolean;
};

/** Result of merging fragments. */
export type MergeResult = {
	/** Conflicting source owners remain unresolved; preview order is not truth. */
	unresolvedConflicts?: string[];
	requiresReview?: boolean;
	truncated?: boolean;
	originalChars?: number;
	strategy: MergeStrategy;
	fusedBody: string;
	provenance: MergeProvenance[];
};

/** Optional planning config. */
export type MergeConfig = {
	maxBodyChars?: number;
};

const DEFAULT_MAX_BODY_CHARS = 32768;
/** Hard ceiling for one fused body, regardless of caller configuration. */
export const MAX_MERGE_BODY_CHARS = 131072;
const TRUNCATION_MARKER = "...[truncated]";
const KINDS: readonly string[] = ["duplicate", "complementary", "conflict"];

function fieldError(index: number | null, field: string, msg: string): never {
	const where = index === null ? "fragments" : `fragments[${index}]`;
	const name = field ? `.${field}` : "";
	throw new TypeError(`${where}${name}: ${msg}`);
}

/** Validates one fragment object; throws TypeError naming the bad field. */
function validateFragmentShape(fragment: unknown, index: number): asserts fragment is Fragment {
	const f = fragment as Record<string, unknown>;
	if (f === null || typeof f !== "object" || Array.isArray(f)) {
		throw fieldError(index, "", "must be an object");
	}
	if (typeof f.owner !== "string" || f.owner.trim().length === 0) {
		throw fieldError(index, "owner", "must be a non-empty string");
	}
	if (typeof f.kind !== "string" || !KINDS.includes(f.kind)) {
		throw fieldError(index, "kind", "must be one of " + KINDS.join("|"));
	}
	if (typeof f.body !== "string" || !f.body.trim()) {
		throw fieldError(index, "body", "must be a non-empty string");
	}
	if (typeof f.updatedAt !== "number" || !Number.isFinite(f.updatedAt)) {
		throw fieldError(index, "updatedAt", "must be a finite number");
	}
}

/** Validates the fragment array; throws TypeError naming the bad field. */
export function validateFragments(fragments: unknown): asserts fragments is Fragment[] {
	if (!Array.isArray(fragments)) {
		throw fieldError(null, "", "must be an array");
	}
	for (let i = 0; i < fragments.length; i++) {
		validateFragmentShape(fragments[i], i);
	}
}

function validateMergeConfig(config: MergeConfig | undefined): number {
	if (config === undefined) return DEFAULT_MAX_BODY_CHARS;
	const c = config as Record<string, unknown>;
	if (c === null || typeof c !== "object" || Array.isArray(c)) {
		throw new TypeError("config must be an object");
	}
	if (c.maxBodyChars === undefined) return DEFAULT_MAX_BODY_CHARS;
	if (typeof c.maxBodyChars !== "number" || !Number.isInteger(c.maxBodyChars) || c.maxBodyChars <= 0) {
		throw new TypeError("config.maxBodyChars must be a positive integer");
	}
	if (c.maxBodyChars > MAX_MERGE_BODY_CHARS) {
		throw new TypeError(`config.maxBodyChars must be <= ${MAX_MERGE_BODY_CHARS}`);
	}
	return c.maxBodyChars;
}

/** Global strategy implied by the fragment kinds. */
export function classifyMergeStrategy(fragments: Fragment[]): MergeStrategy {
	validateFragments(fragments);
	if (fragments.length === 0) return "deduped";
	if (fragments.some((f) => f.kind === "conflict")) return "disjoint-split";
	if (fragments.every((f) => f.kind === "duplicate") && fragments.every(f=>f.body===fragments[0].body)) return "deduped";
	return "union";
}



/**
 * Extracts fenced fragment blocks from a fan-out worker's output (the
 * ```fragment format documented in extensions/pi-subagents/prompts/fanout.md).
 *
 * Text outside fragment blocks is ignored (workers are told not to emit it,
 * but stray prose must not kill a merge). Each fenced block must parse as a
 * valid fragment — malformed blocks throw a TypeError naming the block index,
 * and an unterminated fragment fence is loud for the same reason: the worker
 * announced a fragment it never delivered.
 *
 * Returns [] when the text contains no fragment fence at all — callers decide
 * the fallback (runs.fuse treats such output as one complementary section).
 */
export function parseFragmentBlocks(text: string): Fragment[] {
	if (typeof text !== "string") {
		throw new TypeError("parseFragmentBlocks: text must be a string");
	}
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const openRe = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*fragment[ \t]*(?:\n|$)/gm;
	const fragments: Fragment[] = [];
	let match: RegExpExecArray | null;
	while ((match = openRe.exec(normalized)) !== null) {
		const index = fragments.length, fence = match[1];
		// Markdown fences end on their own line. Backticks inside a JSON body
		// (for example an escaped code block) are ordinary source content.
		const closeRe = new RegExp(`^[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n|$)`, "gm");
		closeRe.lastIndex = openRe.lastIndex;
		const closing = closeRe.exec(normalized);
		if (!closing) throw new TypeError(`fragments[${index}]: unterminated fragment fence`);
		let parsed: unknown;
		try { parsed = JSON.parse(normalized.slice(openRe.lastIndex, closing.index)); }
		catch (error) {
			throw new TypeError(`fragments[${index}]: fenced fragment block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		validateFragmentShape(parsed, index);
		fragments.push(parsed);
		openRe.lastIndex = closeRe.lastIndex;
	}
	return fragments;
}

function byOwnerThenTime(a: Fragment, b: Fragment): number {
	if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
	return a.updatedAt - b.updatedAt;
}

function retainedChars(body: string, maxBodyChars: number): number {
	if (body.length <= maxBodyChars) return body.length;
	let end = maxBodyChars <= TRUNCATION_MARKER.length ? maxBodyChars : maxBodyChars - TRUNCATION_MARKER.length;
	// Never leave a lone UTF-16 high surrogate at the truncation boundary.
	if (end > 0 && /[\uD800-\uDBFF]/.test(body[end - 1]) && /[\uDC00-\uDFFF]/.test(body[end])) end--;
	return end;
}

/**
 * Plans the merge of fragments into a single bounded body with provenance.
 * Deterministic: identical input always yields identical output.
 */
export function mergeFragments(fragments: Fragment[], config?: MergeConfig): MergeResult {
 validateFragments(fragments);
 const maxBodyChars=validateMergeConfig(config);
 const strategy=classifyMergeStrategy(fragments);
 const ordered=fragments.slice().sort((a,b)=>Number(b.kind==="conflict")-Number(a.kind==="conflict")||byOwnerThenTime(a,b));
 const sections=new Map<string,{section:string;start:number;end:number}>();
 let originalChars=0;
 const provenanceOwners=new Map<string,Set<string>>();
 const parts:string[]=[];
 const provenance:MergeProvenance[]=[];
 for(const fragment of ordered) {
  let range=sections.get(fragment.body);
  if(!range){
   const start=originalChars+(parts.length?2:0);
   range={section:`s${sections.size+1}`,start,end:start+fragment.body.length};
   originalChars=range.end;sections.set(fragment.body,range);parts.push(fragment.body);
  }
  const {section}=range;
  let owners=provenanceOwners.get(section);
  if(!owners){owners=new Set<string>();provenanceOwners.set(section,owners);}
  if(!owners.has(fragment.owner)){owners.add(fragment.owner);provenance.push({...range,owner:fragment.owner});}
 }
 const body=parts.join("\n\n");
 const truncated=body.length>maxBodyChars;
 const retained=retainedChars(body,maxBodyChars);
 const fusedBody=body.slice(0,retained)+(truncated&&maxBodyChars>TRUNCATION_MARKER.length?TRUNCATION_MARKER:"");
 return {strategy,fusedBody,provenance:provenance.map(entry=>entry.end<=retained?entry:{...entry,start:Math.min(entry.start,retained),end:retained,...(entry.start>=retained?{omitted:true}:{truncated:true})}),
  ...(truncated?{truncated:true,originalChars:body.length,requiresReview:true}:{}),
  ...(strategy==="disjoint-split"?{requiresReview:true,unresolvedConflicts:[...new Set(fragments.filter(f=>f.kind==="conflict").map(f=>f.owner))]}:{})};
}

// ── Part 2: degraded-child recovery ────────────────────────────────────────
/**
 * Deterministic fan-out degradation recovery planner (2026-09-06 pass).
 *
 * INPUT  : run records for a fan-out plus a recovery config.
 * OUTPUT : which children degraded, and a bounded, scheduled respawn plan.
 *
 * Attempt accounting (1-based):
 *   - the ORIGINAL run of a work item is its unsuffixed key ("fanout") and has
 *     made 0 attempts so far;
 *   - a key "fanout-attempt-N" represents the N-th attempt having already run;
 *   - the next respawn is "fanout-attempt-(N+1)" with entry attempt === N+1;
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

export const RUN_STATUSES: readonly string[] = [
	"completed",
	"error",
	"timeout",
	"budget-exhausted",
	"running",
	"stopped",
];

export const BACKOFF_CAP_MS = 60_000;

export interface RecoveryConfig {
	/** Maximum respawn rounds per work item (the original run does not count). */
	maxRespawnRounds: number;
	/** Base backoff in ms; attempt N waits baseBackoffMs * 2**(N-1), capped. */
	baseBackoffMs: number;
}

export interface RunRecord {
	/** Unique run key. A "-attempt-N" suffix marks attempt N of the base item. */
	key: string;
	status: "completed" | "error" | "timeout" | "budget-exhausted" | "running" | "stopped";
	/** Epoch ms. */
	startedAt: number;
	/** Epoch ms, present when the run ended. */
	endedAt?: number;
	tokens?: number;
}

export interface Respawn {
	/** Key the respawn must run under ("base-attempt-(next)"); never collides across plan entries. */
	key: string;
	/** 1-based respawn attempt number. */
	attempt: number;
	/** Epoch ms before which the respawn must not be launched. */
	notBeforeMs: number;
}

export interface RecoveryResult {
	/** Every record key observed with a degraded status, unique, input order. */
	degraded: string[];
	/** Deterministically sorted (by key) respawn entries for degraded families. */
	respawnPlan: Respawn[];
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
	maxRespawnRounds: 3,
	baseBackoffMs: 5_000,
};

const DEGRADED_STATUSES: ReadonlySet<string> = new Set(["error", "timeout", "budget-exhausted"]);
const ATTEMPT_SUFFIX: RegExp = /^(.*)-attempt-(\d+)$/;

export function planRecovery(
	records: RunRecord[] = [],
	config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
	now: number = 0,
): RecoveryResult {
	validateRecoveryConfig(config);
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
	const families = new Map<string, { base: string; latestAttempt: number; record: RunRecord }>();

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

	const plan: Respawn[] = [];
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

function validateRecoveryConfig(config: RecoveryConfig): void {
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
	if (typeof r.status !== "string" || !(RUN_STATUSES as readonly string[]).includes(r.status)) {
		throw new TypeError(
			`record[${index}].status must be one of ${RUN_STATUSES.join(", ")}, got ${JSON.stringify(r.status)}`,
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
