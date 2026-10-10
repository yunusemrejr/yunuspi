/**
 * Workflow-seam mappers: bridge workflow child results (runs.all-shaped) into
 * the deterministic fan-out merge and recovery planners. Pure functions;
 * malformed input throws TypeErrors naming the offending field (loud, never
 * silently empty). The scripted-workflow sandbox exposes these as
 * runs.recover / runs.fuse / runs.fuseFragments.
 */
import {
	DEFAULT_RECOVERY_CONFIG,
	mergeFragments,
	parseFragmentBlocks,
	planRecovery,
	validateFragments,
	type Fragment,
	type MergeConfig,
	type MergeResult,
	type RecoveryConfig,
	type RunRecord,
} from "../runs/shared/fanout.ts";

/** Shape of one entry as produced by runs.all (post-decoration). */
export type WorkflowChildOutcome = {
	key?: unknown;
	ok?: unknown;
	stopped?: unknown;
	interrupted?: unknown;
	terminalOutcome?: { reason?: unknown };
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
 * Map runs.all results to recovery records. Explicit cancellation is terminal;
 * consumed native budgets remain exhausted; otherwise `ok` decides completed
 * vs error; timestamps collapse to `now` because workflow results do not carry
 * per-child clocks (attempt math drives scheduling, not timestamps).
 */
export function childResultsToRecoveryRecords(results: unknown, now: number): RunRecord[] {
	const items = requireResultsArray(results);
	return items.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new TypeError(`runs.recover: results[${index}] must be an object`);
		}
		const key = requireChildKey(item, index);
		if (typeof item.ok !== "boolean") {
			throw new TypeError(`runs.recover: results[${index}].ok must be a boolean`);
		}
		// Native workflow children retain why a partial run ended. Keep budget
		// exhaustion through this seam so runs.recover cannot mint a fresh
		// budget by treating it as an ordinary failed attempt.
		const status = item.stopped === true || item.interrupted === true ? "stopped"
			: item.ok ? "completed"
				: item.terminalOutcome?.reason === "budget_exhausted" ? "budget-exhausted" : "error";
		return { key, status, startedAt: now, endedAt: now } satisfies RunRecord;
	});
}

/** Plan bounded, deduplicated respawns for degraded fan-out children. */
export function planChildRespawn(
	results: unknown,
	config?: Partial<RecoveryConfig>,
	now: number = Date.now(),
): ReturnType<typeof planRecovery> {
	const records = childResultsToRecoveryRecords(results, now);
	const merged = {
		maxRespawnRounds: config?.maxRespawnRounds ?? DEFAULT_RECOVERY_CONFIG.maxRespawnRounds,
		baseBackoffMs: config?.baseBackoffMs ?? DEFAULT_RECOVERY_CONFIG.baseBackoffMs,
	};
	return planRecovery(records, merged, now);
}

/**
 * Fuse child outputs: fan-out workers (extensions/pi-subagents/prompts/fanout.md)
 * emit fenced ```fragment blocks, which are extracted and merged with their
 * declared kinds; plain-text outputs become one complementary fragment owned
 * by the run key; empty outputs contribute nothing. Object outputs are
 * rejected — structured merges go through runs.fuseFragments where the
 * workflow author classifies kinds explicitly.
 */
export function fuseChildOutputs(results: unknown, config?: Partial<MergeConfig>): MergeResult {
	const items = requireResultsArray(results);
	const now = Date.now();
	const fragments: Fragment[] = [];
	items.forEach((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`runs.fuse: results[${index}] must be an object`);
		if (typeof item.ok !== "boolean") throw new TypeError(`runs.fuse: results[${index}].ok must be a boolean`);
		const key = requireChildKey(item, index);
		if (item.ok === false || item.stopped === true || item.interrupted === true) return;
		if (typeof item.output !== "string") {
			throw new TypeError(`runs.fuse: results[${index}].output must be a string; use runs.fuseFragments for structured input`);
		}
		let parsed: Fragment[];
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
	return mergeFragments(fragments, config as MergeConfig | undefined);
}

/** Fuse explicit, already-classified fragments (structured workflows). */
export function fuseFragments(fragments: unknown, config?: Partial<MergeConfig>): MergeResult {
	validateFragments(fragments);
	return mergeFragments(fragments, config as MergeConfig | undefined);
}
