import * as fs from "node:fs";
import * as path from "node:path";
import { splitKnownThinkingSuffix, type ModelInfo } from "../../shared/model-info.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { findModelExclusion } from "./model-exclusions.ts";
import { describeFreeRoutes } from "./free-route-evidence.ts";
import {
	isAutonomousMeteredEligible,
	economyComparisonCost,
	operationalEconomyQualification,
	compareObservedEconomySpeed,
	type EconomyWorkload,
	loadModelEconomyConfig,
	type ModelEconomyConfig,
} from "./model-economy.ts";

/**
 * Deterministic autonomous model selection (2026-09-06 pass).
 *
 * Rules (offline by default; ranking cache is advisory only):
 *   * Only models with KNOWN metered input+output rates at or below the
 *     configured caps are eligible (see model-economy.ts). Unknown, zero and
 *     placeholder prices never qualify.
 *   * Declared subscription providers (e.g. openai-codex) are used ONLY as a
 *     last resort when no metered route within the caps remains.
 *   * Unknown or too-small context windows are excluded from the autonomous pool.
 *   * Selection is deterministic: lowest metered price wins; popularity and
 *     benchmark data from a valid local ranking cache are surfaced in the
 *     explanation and used only as a tie-break — popularity NEVER overrides
 *     the price cap.
 *   * No timers, no network. `refreshModelRankingCache` is the single,
 *     explicit refresh entry point (the parent session calls it against a
 *     bounded source); failed refreshes report failure without throwing.
 */

const MIN_AUTONOMOUS_CONTEXT_TOKENS = 8192;
const RANK_CACHE_FILE = "subagents-model-rank.json";
const RANK_CACHE_VERSION = 1;

export interface ModelRankCache {
	version: number;
	fetchedAt: string;
	asOf: string;
	coding?: Array<{ model: string; share: number }>;
	benchmarks?: Array<{ model: string; score: number }>;
}

export interface AffordableSelectionOptions {
 /** Caller-known workload only. Cache counts must be established, never guessed. */
 workload?: EconomyWorkload;
 /** Task requirements may narrow the pool; unspecified requirements retain parent capacity. */
 requirements?: { minContextWindow?: number; minOutputTokens?: number; reasoning?: boolean; inputModalities?: string[] };

	/** Prefer the same model identity within eligible routes, without lifting caps. */
	preferredModel?: string;
	exclude?: string[];
	/** Providers currently quota-exhausted; their routes are dropped from the pool. */
	exhaustedProviders?: string[];
	/** Kept for API compatibility: the autonomous path is offline and never
	 *  self-triggers a refresh; pass the cache through {@link refreshModelRankingCache}. */
	skipRefresh?: boolean;
}

export interface AffordableSelection {
	/** Canonical `provider/id` of the selected route. */
	model: string;
	/** Deterministic, human-readable explanation lines. */
	explanation: string[];
	/** True when the local ranking cache was absent/invalid (offline rule applied). */
	offline?: boolean;
}

export interface RankRefreshResult {
	ok: boolean;
	reason?: string;
	filePath?: string;
}

function rankCachePath(): string {
	return path.join(getAgentDir(), "cache", RANK_CACHE_FILE);
}

function readRankCache(): { cache?: ModelRankCache; offline: boolean; note?: string } {
	const filePath = rankCachePath();
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return { offline: true };
	}
	return isRankCacheValid(parsed) ? { cache: parsed, offline: false } : { offline: true };
}

function contextTooSmall(model: ModelInfo): boolean {
	return typeof model.contextWindow !== "number" || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < MIN_AUTONOMOUS_CONTEXT_TOKENS;
}


function subscriptionEligible(model: ModelInfo, cfg: ModelEconomyConfig): boolean {
	return cfg.subscriptionProviders.includes(model.provider);
}

/**
 * Deterministically pick the affordable route for an autonomous subagent.
 * Returns `undefined` when no known-affordable route remains in the pool.
 */
export function selectAffordableModel(
	models: ModelInfo[] | undefined,
	cfg: ModelEconomyConfig,
	options?: AffordableSelectionOptions,
): AffordableSelection | undefined {
	const preferredBase = options?.preferredModel ? splitKnownThinkingSuffix(options.preferredModel).baseModel : undefined;
	const reference = models?.find(m=>m.fullId===preferredBase);
	const hasCapacity = (model:ModelInfo) => {
        const required = options?.requirements;
        if (required?.minContextWindow !== undefined && (!Number.isSafeInteger(required.minContextWindow) || required.minContextWindow <= 0 || !(typeof model.contextWindow === "number" && model.contextWindow >= required.minContextWindow))) return false;
        if (required?.minOutputTokens !== undefined && (!Number.isSafeInteger(required.minOutputTokens) || required.minOutputTokens <= 0 || !(typeof model.maxTokens === "number" && model.maxTokens >= required.minOutputTokens))) return false;
        if (required?.reasoning === true && model.reasoning !== true) return false;
        if (required?.inputModalities?.some(input => !model.input?.includes(input))) return false;

		if(reference?.contextWindow && !(typeof model.contextWindow === "number" && model.contextWindow >= reference.contextWindow))return false;
		if(reference?.maxTokens && !(typeof model.maxTokens === "number" && model.maxTokens >= reference.maxTokens))return false;
		if(reference?.input?.includes("image") && !model.input?.includes("image"))return false;
		if(reference?.reasoning === true && model.reasoning !== true)return false;
		return true;
	};
	const pool = (models ?? []).filter((model) => {
		if (!hasCapacity(model)) return false;
		if (options?.exclude?.includes(model.fullId) || findModelExclusion(model.fullId)) return false;
		if (options?.exhaustedProviders?.length) {
			const provider = model.fullId.slice(0, model.fullId.indexOf("/"));
			if (provider && options.exhaustedProviders.includes(provider)) return false;
		}
		return true;
	});
	// One evidence snapshot for the whole selection, rather than disk I/O per model.
	const freeReport = describeFreeRoutes(pool, {requirements:{minContextWindow:MIN_AUTONOMOUS_CONTEXT_TOKENS, toolCalling:true}});
	const preferred = reference;
	const preferredId = preferred?.id ?? options?.preferredModel?.slice((options.preferredModel.indexOf("/") ?? -1)+1);
	const same = (id:string) => Number(!!preferredId && id === preferredId);
	const free = freeReport.candidates.filter(c=>c.eligible).sort((a,b)=>same(b.id)-same(a.id)||(a.rank??Infinity)-(b.rank??Infinity));
    if (free.length) {
        const anchor=pool.find(model=>model.fullId===free[0]!.route);
        const speed=new Map(free.map(candidate=>{const model=pool.find(m=>m.fullId===candidate.route);return [candidate.route,anchor&&model?Math.min(0,compareObservedEconomySpeed(model,anchor)):0];}));
        free.sort((a,b)=>same(b.id)-same(a.id)||(speed.get(a.route)??0)-(speed.get(b.route)??0)||(a.rank??Infinity)-(b.rank??Infinity)||a.route.localeCompare(b.route));
        return {model:free[0]!.route,explanation:["free-first: verified free pricing, tool support and minimum context; same identity preferred, then comparable observed response speed and evidence/capacity rank"]};
    }
	const explanation: string[] = [];
	const eligible = pool.filter((model) => {
		if (contextTooSmall(model)) return false;
		if (isAutonomousMeteredEligible(model, cfg)) return Number.isFinite(economyComparisonCost(model, options?.workload));
		if (subscriptionEligible(model, cfg)) return true;
		return false;
	});
	if (eligible.length === 0) return undefined;
	const { cache, offline } = readRankCache();
	if (cache) {
		explanation.push(`local ranking cache consulted (as_of ${cache.asOf}); popularity/benchmarks never override the automatic price cap`);
	} else {
		explanation.push("no usable local ranking cache: offline cheapest-member rule applies");
	}
    const priceReference=eligible.filter(model=>isAutonomousMeteredEligible(model,cfg)).slice().sort((a,b)=>economyComparisonCost(a,options?.workload)-economyComparisonCost(b,options?.workload)||a.fullId.localeCompare(b.fullId))[0];
    const cheapestCost=priceReference?economyComparisonCost(priceReference,options?.workload):Infinity;
    // Fixed cheapest-route anchor avoids non-transitive pairwise cost/latency tradeoffs.
    const speedScores=new Map(eligible.map(model=>[model.fullId,priceReference && economyComparisonCost(model,options?.workload)<=cheapestCost*1.1 ? Math.min(0,compareObservedEconomySpeed(model,priceReference)):0]));
    const compareCost=(a:ModelInfo,b:ModelInfo)=>{
        const left=economyComparisonCost(a,options?.workload),right=economyComparisonCost(b,options?.workload);
        const group=Number(left>cheapestCost*1.1)-Number(right>cheapestCost*1.1);
        return group || (speedScores.get(a.fullId)??0)-(speedScores.get(b.fullId)??0) || left-right;
    };

	const metered = eligible
		.filter((model) => isAutonomousMeteredEligible(model, cfg))
		.sort((a, b) => {
			const priceDelta = compareCost(a,b);
			return priceDelta !== 0 ? priceDelta : a.fullId.localeCompare(b.fullId);
		});
	const ranked = cache
		? metered
				.slice()
				.sort((a, b) => {
					const scoreOf = (model: ModelInfo) => {
						const id = model.id.slice(model.id.lastIndexOf("/") + 1);
						const coding = cache.coding?.find((entry) => entry.model === model.id || entry.model === id)?.share ?? 0;
						const benchmark = cache.benchmarks?.find((entry) => entry.model === model.id || entry.model === id)?.score ?? 0;
						return { coding, benchmark };
					};
					const aScore = scoreOf(a);
					const bScore = scoreOf(b);
					return compareCost(a,b) ||
						bScore.coding - aScore.coding || bScore.benchmark - aScore.benchmark ||
						a.fullId.localeCompare(b.fullId);
				})
		: metered;
	const chosen = ranked[0];
	if (chosen) {
        const qualification=operationalEconomyQualification(chosen,cfg);
        if(qualification)explanation.push(qualification.reason);
		explanation.push(`offline cheapest-member rule with observed speed tie-break within 10% cost: pick an eligible metered route (${chosen.fullId})`);
		if (options?.workload) explanation.push("comparison uses caller-supplied token buckets and worst-case tiers; cache reuse is conditional, not guaranteed");
		return { model: chosen.fullId, explanation, ...(offline ? { offline: true } : {}) };
	}
	const subscription = eligible
		.filter((model) => subscriptionEligible(model, cfg))
		.sort((a, b) => a.fullId.localeCompare(b.fullId))[0];
	if (subscription) {
		explanation.push(`no metered route within the automatic budget remains; using the declared subscription route ${subscription.fullId}`);
		return { model: subscription.fullId, explanation, ...(offline ? { offline: true } : {}) };
	}
	return undefined;
}

function isRankCacheValid(cache: unknown): cache is ModelRankCache {
	if (!cache || typeof cache !== "object" || Array.isArray(cache)) return false;
	const candidate = cache as ModelRankCache;
	if (candidate.version !== RANK_CACHE_VERSION) return false;
	for (const value of [candidate.fetchedAt, candidate.asOf]) {
		if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value)) || Date.parse(value) > Date.now()) return false;
	}
	for (const [rows, score] of [[candidate.coding, "share"], [candidate.benchmarks, "score"]] as const) {
		if (rows === undefined) continue;
		if (!Array.isArray(rows) || rows.length > 10_000) return false;
		const seen = new Set<string>();
		for (const row of rows) {
			if (!row || typeof row !== "object" || Array.isArray(row)) return false;
			const entry = row as unknown as Record<string, unknown>;
			if (typeof entry.model !== "string" || !entry.model.trim() || entry.model.length > 512 || /[\u0000-\u001f\u007f]/.test(entry.model) || seen.has(entry.model)) return false;
			if (typeof entry[score] !== "number" || !Number.isFinite(entry[score]) || entry[score] < 0) return false;
			seen.add(entry.model);
		}
	}
	return true;
}

/**
 * Explicitly refresh the local model-ranking cache through `loader` (the
 * parent supplies a bounded, network-capable source). Failures report
 * `{ ok: false, reason }` and never throw.
 */
export async function refreshModelRankingCache(
	loader: () => Promise<{ ok: boolean; status?: number; reason?: string; body?: unknown }>,
): Promise<RankRefreshResult> {
	let result: { ok: boolean; status?: number; reason?: string; body?: unknown };
	try {
		result = await loader();
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
	if (!result.ok || !isRankCacheValid(result.body)) {
		const status = typeof result.status === "number" ? ` (status ${result.status})` : "";
		return {
			ok: false,
			reason: `subagent model ranking refresh failed${status}${result.reason ? `: ${result.reason}` : ""}`,
		};
	}
	const filePath = rankCachePath();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `${JSON.stringify(result.body, null, "\t")}\n`);
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true, filePath };
}

// Re-exported for callers that need the same default caps without loading twice.
export { loadModelEconomyConfig };
