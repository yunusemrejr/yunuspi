/**
 * Workflow-seam mappers: bridge workflow child results (runs.all-shaped) into
 * the deterministic swarm-recovery and fusion policy modules. Pure functions;
 * malformed input throws TypeErrors naming the offending field (loud, never
 * silently empty). The scripted-workflow sandbox exposes these as
 * runs.recover / runs.fuse / runs.fuseFragments.
 */
import {
	planFusion,
	parseFragmentBlocks,
	validateFragments,
	type FusionConfig,
	type FusionFragment,
	type FusionResult,
} from "../runs/shared/fusion.ts";
import {
	DEFAULT_CONFIG,
	planSwarmRecovery,
	type SwarmRecoveryConfig,
	type SwarmRecoveryResult,
	type SwarmRunRecord,
} from "../runs/shared/swarm-recovery.ts";

/** Shape of one entry as produced by runs.all (post-decoration). */
export type WorkflowChildOutcome = {
	key?: unknown;
	ok?: unknown;
	stopped?: unknown;
	interrupted?: unknown;
	output?: unknown;
};

function requireResultsArray(results: unknown): WorkflowChildOutcome[] {
	if (!Array.isArray(results)) throw new TypeError("runs.recover/fuse: results must be an array");
	return results as WorkflowChildOutcome[];
}

function requireChildKey(item: WorkflowChildOutcome, index: number): string {
	if (typeof item.key !== "string" || !item.key) {
		throw new TypeError(`runs.recover/fuse: results[${index}].key must be a non-empty string`);
	}
	return item.key;
}

/**
 * Map runs.all results to swarm recovery records. Explicit cancellation is terminal;
 * otherwise `ok` decides completed vs
 * error; timestamps collapse to `now` because workflow results do not carry
 * per-child clocks (attempt math drives scheduling, not timestamps).
 */
export function childResultsToRecoveryRecords(results: unknown, now: number): SwarmRunRecord[] {
	const items = requireResultsArray(results);
	return items.map((item, index) => {
		if (!item || typeof item !== "object") {
			throw new TypeError(`runs.recover: results[${index}] must be an object`);
		}
		const key = requireChildKey(item, index);
		if (typeof item.ok !== "boolean") {
			throw new TypeError(`runs.recover: results[${index}].ok must be a boolean`);
		}
		const status = item.stopped === true || item.interrupted === true ? "stopped" : item.ok ? "completed" : "error";
		return { key, status, startedAt: now, endedAt: now } satisfies SwarmRunRecord;
	});
}

/** Plan bounded, deduplicated respawns for degraded fan-out children. */
export function planChildRespawn(
	results: unknown,
	config?: Partial<SwarmRecoveryConfig>,
	now: number = Date.now(),
): ReturnType<typeof planSwarmRecovery> {
	const records = childResultsToRecoveryRecords(results, now);
	const merged = {
		maxRespawnRounds: config?.maxRespawnRounds ?? DEFAULT_CONFIG.maxRespawnRounds,
		baseBackoffMs: config?.baseBackoffMs ?? DEFAULT_CONFIG.baseBackoffMs,
	};
	return planSwarmRecovery(records, merged, now);
}

/**
 * Fuse child outputs: fusion-mode workers (extensions/pi-subagents/prompts/fusion.md)
 * emit fenced ```fragment blocks, which are extracted and merged with their
 * declared kinds; plain-text outputs become one complementary fragment owned
 * by the run key; empty outputs contribute nothing. Object outputs are
 * rejected — structured fusion goes through runs.fuseFragments where the
 * workflow author classifies kinds explicitly.
 */
export function fuseChildOutputs(results: unknown, config?: Partial<FusionConfig>): FusionResult {
	const items = requireResultsArray(results);
	const now = Date.now();
	const fragments: FusionFragment[] = [];
	items.forEach((item, index) => {
		const key = requireChildKey(item, index);
		if (item.ok === false || item.stopped === true || item.interrupted === true) return;
		if (typeof item.output !== "string") {
			throw new TypeError(`runs.fuse: results[${index}].output must be a string; use runs.fuseFragments for structured input`);
		}
		let parsed: FusionFragment[];
		try {
			parsed = parseFragmentBlocks(item.output);
		} catch (error) {
			throw new TypeError(`runs.fuse: results[${index}] (key '${key}'): ${error instanceof Error ? error.message : String(error)}`);
		}
		if (parsed.length > 0) {
			fragments.push(...parsed.map(fragment => ({...fragment, owner:key})));
			return;
		}
		if (item.output.trim().length === 0) return;
		fragments.push({ owner: key, kind: "complementary", body: item.output, updatedAt: now });
	});
	return planFusion(fragments, config as FusionConfig | undefined);
}

/** Fuse explicit, already-classified fragments (structured workflows). */
export function fuseFragments(fragments: unknown, config?: Partial<FusionConfig>): FusionResult {
	validateFragments(fragments);
	return planFusion(fragments, config as FusionConfig | undefined);
}
