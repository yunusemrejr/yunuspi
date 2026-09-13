import * as fs from "node:fs";
import { readHealth, recoveryPerformance, evaluateRoute } from "./provider-health.ts";
import * as path from "node:path";
import { splitKnownThinkingSuffix, type ModelInfo } from "../../shared/model-info.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { findModelExclusion } from "./model-exclusions.ts";
import { describeFreeRoutes, catalogRouteCapabilities, readFreeEvidence } from "./free-route-evidence.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { assessModelQuality, compareModelVersions, validBenchmark, taskQuality, type BenchmarkEvidence, type ModelDiscovery, type QualityTask } from "./model-quality.ts";
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
 * Deterministic autonomous model selection. Capability and task quality gates
 * precede free/cheap preference; operational reliability is a separate axis.
 *
 * Rules (selection is always offline):
 *   * Only models with KNOWN metered input+output rates at or below the
 *     configured caps are eligible (see model-economy.ts). Unknown, zero and
 *     placeholder prices never qualify.
 *   * Declared subscription providers (e.g. openai-codex) are used ONLY as a
 *     last resort when no metered route within the caps remains.
 *   * Unknown or too-small context windows are excluded from the autonomous pool.
 *   * Task-aware callers require source-backed, comparable benchmark evidence
 *     or the selected reference identity. Unknown peers are advisory only.
 *   * Free-first within quality gates, then inexpensive metered routes.
 *     Legacy ranking data never overrides quality or the automatic price cap.
 *   * No timers/network on selection. Background model research publishes
 *     through refreshModelRankingCache; failures retain prior evidence.
 */

const MIN_AUTONOMOUS_CONTEXT_TOKENS = 8192;
const RANK_CACHE_FILE = "subagents-model-rank.json";
const RANK_CACHE_VERSION = 2;

export interface ModelRankCache {
	version: number;
	fetchedAt: string;
	asOf: string;
	coding?: Array<{ model: string; share: number }>;
	benchmarks?: Array<{ model: string; score: number }>;
 observations?: BenchmarkEvidence[];
 discoveries?: ModelDiscovery[];
 researchAt?: number;
 researchCatalog?: string;
}

export interface AffordableSelectionOptions {
 task?: string;
 quality?: QualityTask;
 /** Explicit workload requirements replace parent capacity only where supplied. */
 freeOnly?: boolean;
 /** Caller-known workload only. Cache counts must be established, never guessed. */
 workload?: EconomyWorkload;
 /** Task requirements may narrow the pool; unspecified requirements retain parent capacity. */
 requirements?: { minContextWindow?: number; minOutputTokens?: number; reasoning?: boolean; inputModalities?: string[]; toolCalling?: boolean };

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

let rankSnapshot: { key: string; cache: ModelRankCache } | undefined;
export function readRankCache(): { cache?: ModelRankCache; offline: boolean; note?: string } {
	const filePath = rankCachePath();
	let parsed: unknown;
	try {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 4*1024*1024) return {offline:true};
  const key = `${filePath}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (rankSnapshot?.key === key) return {cache:rankSnapshot.cache,offline:false};
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (isRankCacheValid(parsed)) { rankSnapshot = {key,cache:parsed}; return {cache:parsed,offline:false}; }
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
 const evidence = readFreeEvidence();
	const hasCapacity = (model:ModelInfo) => {
        const required = options?.requirements;
        if (required?.minContextWindow !== undefined && (!Number.isSafeInteger(required.minContextWindow) || required.minContextWindow <= 0 || !(typeof model.contextWindow === "number" && model.contextWindow >= required.minContextWindow))) return false;
        if (required?.minOutputTokens !== undefined && (!Number.isSafeInteger(required.minOutputTokens) || required.minOutputTokens <= 0 || !(typeof model.maxTokens === "number" && model.maxTokens >= required.minOutputTokens))) return false;
        if (required?.reasoning === true && model.reasoning !== true) return false;
        if (required?.inputModalities?.some(input => !model.input?.includes(input))) return false;
        if (required?.toolCalling && catalogRouteCapabilities(model,evidence)?.toolCalling !== true) return false;

		if(required?.minContextWindow === undefined && reference?.contextWindow && !(typeof model.contextWindow === "number" && model.contextWindow >= reference.contextWindow))return false;
		if(required?.minOutputTokens === undefined && reference?.maxTokens && !(typeof model.maxTokens === "number" && model.maxTokens >= reference.maxTokens))return false;
		if(required?.inputModalities === undefined && reference?.input?.includes("image") && !model.input?.includes("image"))return false;
		if(required?.reasoning === undefined && reference?.reasoning === true && model.reasoning !== true)return false;
		return true;
	};
 const timestamp = Date.now();
 const health = readHealth();
 const { cache, offline } = readRankCache();
 const qualityTask = options?.quality ?? (options?.task ? taskQuality(options.task) : undefined);
 const histories = new Map((models ?? []).map(m=>[m.fullId,recoveryPerformance(health.providers[m.provider]?.models[m.id],m,timestamp)]));
	let pool = (models ?? []).filter((model) => {
		if (!hasCapacity(model)) return false;
  if (!evaluateRoute({provider:model.provider,model:model.id,now:timestamp},health).allowed) return false;
  const history = histories.get(model.fullId)!;
  if (history.samples >= 4 && history.failureRate > .65) return false;
		if (options?.exclude?.includes(model.fullId) || findModelExclusion(model.fullId)) return false;
		if (options?.exhaustedProviders?.length) {
			const provider = model.fullId.slice(0, model.fullId.indexOf("/"));
			if (provider && options.exhaustedProviders.includes(provider)) return false;
		}
		return true;
	});
	// One evidence snapshot for the whole selection, rather than disk I/O per model.
	const freeReport = describeFreeRoutes(pool, {evidence,requirements:{minContextWindow:MIN_AUTONOMOUS_CONTEXT_TOKENS, toolCalling:true}});
 const freeIds = new Set(freeReport.candidates.filter(c=>c.eligible).map(c=>c.route));
 const qualityPool = pool.filter(m=>freeIds.has(m.fullId) || !options?.freeOnly && (isAutonomousMeteredEligible(m,cfg) || subscriptionEligible(m,cfg)));
 const quality = qualityTask ? assessModelQuality(qualityPool,cache?.observations ?? [],qualityTask,reference,timestamp) : undefined;
 if (quality) pool = pool.filter(m=>quality.get(m.fullId)?.eligible);
	const preferred = reference;
	const preferredId = preferred?.id ?? options?.preferredModel?.slice((options.preferredModel.indexOf("/") ?? -1)+1);
 const qualityRank = (id:string) => quality?.get(id)?.confidence === "measured" ? 0 : quality?.get(id)?.confidence === "reference" ? 1 : 2;
 const versionRank = new Map(pool.map(model => [model.fullId,pool.filter(other => {
  const a=quality?.get(model.fullId), b=quality?.get(other.fullId);
  return a?.confidence === "measured" && b?.confidence === "measured" && a.relative! >= b.relative! && compareModelVersions(model.id,other.id)>0;
 }).length]));
 const bestRelative = Math.max(0,...[...(quality?.values() ?? [])].map(q=>q.relative??0));
 const qualityBand = (id:string) => Math.floor(Math.max(0,bestRelative-(quality?.get(id)?.relative??0))/.03);
 const qualityCompare = (a:string,b:string) => qualityRank(a)-qualityRank(b) || qualityBand(a)-qualityBand(b) || (versionRank.get(b)??0)-(versionRank.get(a)??0);
	const same = (id:string) => Number(!!preferredId && id === preferredId);
	const free = freeReport.candidates.filter(c=>c.eligible && (!quality || quality.get(c.route)?.eligible)).sort((a,b)=>same(b.id)-same(a.id)||(a.rank??Infinity)-(b.rank??Infinity));
    if (free.length) {
        const anchor=pool.find(model=>model.fullId===free[0]!.route);
        const speed=new Map(free.map(candidate=>{const model=pool.find(m=>m.fullId===candidate.route);return [candidate.route,anchor&&model?Math.min(0,compareObservedEconomySpeed(model,anchor)):0];}));
        free.sort((a,b)=>qualityCompare(a.route,b.route) || same(b.id)-same(a.id) || histories.get(a.route)!.failureRate-histories.get(b.route)!.failureRate || (speed.get(a.route)??0)-(speed.get(b.route)??0)||(a.rank??Infinity)-(b.rank??Infinity)||a.route.localeCompare(b.route));
        return {model:free[0]!.route,explanation:["free-first after task quality, verified free pricing, tool support, capacity and route-health gates",...(quality ? [quality.get(free[0]!.route)!.reason] : ["task quality unspecified; catalog capacity is not a quality measurement"]),"provider reliability and observed response speed do not establish model intelligence"]};
    }
	if (options?.freeOnly) return undefined;
	const explanation: string[] = [];
	const eligible = pool.filter((model) => {
		if (contextTooSmall(model)) return false;
		if (isAutonomousMeteredEligible(model, cfg)) return Number.isFinite(economyComparisonCost(model, options?.workload));
		if (subscriptionEligible(model, cfg)) return true;
		return false;
	});
	if (eligible.length === 0) return undefined;
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
        return qualityRank(a.fullId)-qualityRank(b.fullId) || group || (speedScores.get(a.fullId)??0)-(speedScores.get(b.fullId)??0) || left-right || qualityCompare(a.fullId,b.fullId);
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
        if (quality) explanation.push(quality.get(chosen.fullId)!.reason,"free candidates failed a task, capability or operational gate; paid price does not imply quality");
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
	if (candidate.version !== RANK_CACHE_VERSION && candidate.version !== 1) return false;
	for (const value of [candidate.fetchedAt, candidate.asOf]) {
		if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value)) || Date.parse(value) > Date.now()) return false;
	}
 if (candidate.researchAt !== undefined && (!Number.isFinite(candidate.researchAt) || candidate.researchAt <= 0 || candidate.researchAt > Date.now())) return false;
 if (candidate.researchCatalog !== undefined && !/^[a-f0-9]{64}$/.test(candidate.researchCatalog)) return false;
 if (candidate.observations !== undefined && (!Array.isArray(candidate.observations) || candidate.observations.length>10000 || !candidate.observations.every(b=>validBenchmark(b)))) return false;
 if (candidate.discoveries !== undefined && (!Array.isArray(candidate.discoveries) || candidate.discoveries.length>1000 || !candidate.discoveries.every(d => d && typeof d.model === "string" && d.model.length<=512 && Number.isFinite(d.checkedAt) && d.checkedAt>0 && d.checkedAt<=Date.now() && Array.isArray(d.sources) && d.sources.length<=4 && d.sources.every(url=>{try {const u=new URL(url);return url.length<=2048 && u.protocol==="https:" && !u.username && !u.password;} catch {return false;}})))) return false;
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
	let lock: string | undefined;
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic replacement plus exclusive publication; a slow refresh cannot
  // overwrite newer evidence produced by another live session.
  const lockPath = `${filePath}.publish-lock`;
  fs.mkdirSync(lockPath); lock = lockPath;
  const prior = readRankCache().cache;
  if (prior && Date.parse(prior.fetchedAt) > Date.parse(result.body.fetchedAt)) return {ok:false,reason:"newer model evidence already published"};
  writePrivateAtomicJson(filePath,result.body);
	  rankSnapshot = undefined;
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	} finally { if(lock) {try {fs.rmdirSync(lock);} catch { /* Failed cleanup must not replace a published result. */ }} }
	return { ok: true, filePath };
}

// Re-exported for callers that need the same default caps without loading twice.
export { loadModelEconomyConfig };

/** Conservative identity comparison: keep versions/variants, allow a registry's
 * unqualified id to match a namespaced id. Never guess model families or tiers. */
export function sameRecoveryModel(a: ModelInfo, b: ModelInfo): boolean {
 const left=a.id.toLowerCase(), right=b.id.toLowerCase();
 return left===right || !left.includes("/") && right.endsWith("/"+left) || !right.includes("/") && left.endsWith("/"+right);
}

/** Continuity selection differs from cheap helper selection. The caller owns
 * capability/price admission; identity, measured reliability and proximity win
 * inside that pool. Catalog capacity and benchmark similarity are proxies, not
 * a claim that different models have equal intelligence. */
export function selectRecoveryModel(models: ModelInfo[], primary: ModelInfo, now=Date.now()): AffordableSelection | undefined {
 const {cache}=readRankCache();
 const state=readHealth();
 const benchmark=(m:ModelInfo)=>cache?.benchmarks?.find(row=>row.model===m.fullId || row.model===m.id)?.score;
 const reference=benchmark(primary);
 const distance=(a:number|undefined,b:number|undefined)=>a && b ? Math.min(3,Math.abs(Math.log2(a/b))) : 1;
 const cost=(m:ModelInfo)=>m.cost ? m.cost.input+m.cost.output : undefined;
 const rows=models.filter(m=>!findModelExclusion(m.fullId)).map(model=>{
  const history=recoveryPerformance(state.providers[model.provider]?.models[model.id], model, now);
  const score=benchmark(model);
  const similarity=reference!==undefined && score!==undefined ? Math.min(3,Math.abs(score-reference)/Math.max(1,Math.abs(reference)))*4
   : distance(model.contextWindow,primary.contextWindow)*.5 + distance(model.maxTokens,primary.maxTokens)*.25 + Number(model.reasoning!==primary.reasoning);
  const priceDistance=distance(cost(model),cost(primary));
  const speed=history.msPerToken ? Math.min(2, Math.log1p(history.msPerToken)/5) : 1;
  return {model,history,same:sameRecoveryModel(primary,model),score:similarity+history.failureRate*4+priceDistance*.25+speed*.25};
 });
 rows.sort((a,b)=>Number(b.same)-Number(a.same)||a.score-b.score||a.model.fullId.localeCompare(b.model.fullId));
 const pick=rows[0];
 if(!pick)return;
 return {model:pick.model.fullId,explanation:[`${pick.same ? "same model identity" : "closest catalog/benchmark profile within admitted capabilities"}; ${pick.history.samples} recent outcome samples; ${Math.round(pick.history.failureRate*100)}% smoothed failure estimate; price and observed speed included`]};
}
