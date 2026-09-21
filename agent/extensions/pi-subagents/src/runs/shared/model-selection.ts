import * as fs from "node:fs";
import { readHealth, recoveryPerformance, evaluateRoute, type ProviderHealthState } from "./provider-health.ts";
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
import type { ChildRouteRequirements } from "./child-route-requirements.ts";
import { recordRouteDecision, type CandidateRejection, type RejectionDimension, type RouteDecisionRecord } from "./route-decision-record.ts";

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
const PUBLISH_LOCK_STALE_MS = 60_000;

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
	/**
	 * Child-specific requirements built from the actual launch (see
	 * child-route-requirements.ts). When present, the child is routed against
	 * its own workload: parent capacity is a quality/reference baseline only
	 * and never a capacity gate. Explicit `requirements` still win where set.
	 */
	child?: ChildRouteRequirements;
	/** Backend/tool-wire compatibility evidence per route, when preflighted. */
	toolWire?: { backend?: string; tools?: string[]; compatible?: (route: string) => { ok: boolean; reason?: string } };
	/** Decision-record envelope for observability (bounded, persisted by caller). */
	decision?: { taskHash?: string; preferenceRole?: string };

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
	/** Bounded structured decision record (pool, rejections, choice). Always attached. */
	decision?: RouteDecisionRecord;
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

export interface SelectionGateContext {
	timestamp: number;
	health: ProviderHealthState;
	evidence: ReturnType<typeof readFreeEvidence>;
	histories: Map<string, ReturnType<typeof recoveryPerformance>>;
	reference?: ModelInfo;
	effectiveRequirements?: { minContextWindow?: number; minOutputTokens?: number; reasoning?: boolean; inputModalities?: string[]; toolCalling?: boolean };
	/** True when child-specific bounds were supplied: the parent reference is a
	 * quality baseline only and never a capacity gate on any dimension. */
	childScoped?: boolean;
	options?: AffordableSelectionOptions;
}

/** Shared hard-gate evaluation: selection and diagnostics cannot disagree. */
export function buildSelectionGateContext(
	models: ModelInfo[] | undefined,
	options: AffordableSelectionOptions | undefined,
	timestamp = Date.now(),
	health: ProviderHealthState = readHealth(),
): SelectionGateContext {
	const preferredBase = options?.preferredModel ? splitKnownThinkingSuffix(options.preferredModel).baseModel : undefined;
	const reference = models?.find(m => m.fullId === preferredBase);
	const childBounds = options?.child ? {
		minContextWindow: options.child.minContextWindow,
		minOutputTokens: options.child.minOutputTokens,
		reasoning: options.child.reasoning,
		inputModalities: options.child.inputModalities,
		toolCalling: options.child.toolCalling,
	} : undefined;
	const effectiveRequirements = options?.requirements ? { ...childBounds, ...options.requirements } : childBounds;
	return {
		timestamp,
		health,
		evidence: readFreeEvidence(),
		histories: new Map((models ?? []).map(m => [m.fullId, recoveryPerformance(health.providers[m.provider]?.models[m.id], m, timestamp)])),
		reference,
		effectiveRequirements,
		...(options?.child ? { childScoped: true as const } : {}),
		options,
	};
}

/**
 * Orthogonal hard-gate dimensions for one candidate: capacity, tool-wire,
 * provider cooling, reliability history, exclusions, quota. Empty dimensions
 * means the candidate passes the hard gates. Quality, free-proof, and price
 * gates layer on top (see describeSelectionRejections).
 */
export function evaluateCandidateGates(model: ModelInfo, ctx: SelectionGateContext): CandidateRejection {
	const dimensions: RejectionDimension[] = [];
	const detail: CandidateRejection["detail"] = {};
	const required = ctx.effectiveRequirements;
	const reference = ctx.reference;
	// Malformed bounds fail closed (reject every candidate), matching the
	// historical gate: a nonsense requirement must never silently pass.
	const saneInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
	if (required?.minContextWindow !== undefined && !saneInt(required.minContextWindow)) {
		dimensions.push("context"); detail.context = "invalid minContextWindow requirement";
	} else if (required?.minContextWindow !== undefined && !(typeof model.contextWindow === "number" && model.contextWindow >= required.minContextWindow)) {
		dimensions.push("context"); detail.context = `needs ${required.minContextWindow}, has ${model.contextWindow ?? "unknown"}`;
	}
	if (required?.minOutputTokens !== undefined && !saneInt(required.minOutputTokens)) {
		dimensions.push("output"); detail.output = "invalid minOutputTokens requirement";
	} else if (required?.minOutputTokens !== undefined && !(typeof model.maxTokens === "number" && model.maxTokens >= required.minOutputTokens)) {
		dimensions.push("output"); detail.output = `needs ${required.minOutputTokens}, has ${model.maxTokens ?? "unknown"}`;
	}
	if (required?.reasoning === true && model.reasoning !== true) { dimensions.push("modality"); detail.modality = "reasoning required"; }
	if (required?.inputModalities?.some(input => !model.input?.includes(input))) {
		dimensions.push("modality"); detail.modality = `missing ${required.inputModalities.filter(input => !model.input?.includes(input)).join(",")}`;
	}
	if (required?.toolCalling && catalogRouteCapabilities(model, ctx.evidence)?.toolCalling !== true) {
		dimensions.push("tool-schema"); detail["tool-schema"] = "tool calling not advertised";
	}
	if (ctx.options?.toolWire?.compatible) {
		const wire = ctx.options.toolWire.compatible(model.fullId);
		if (!wire.ok) { dimensions.push("backend-compat"); detail["backend-compat"] = wire.reason ?? `incompatible with ${ctx.options.toolWire.backend ?? "backend"}`; }
	}
	if (!ctx.childScoped && required?.minContextWindow === undefined && reference?.contextWindow && !(typeof model.contextWindow === "number" && model.contextWindow >= reference.contextWindow)) {
		dimensions.push("context"); detail.context = `below parent baseline ${reference.contextWindow}`;
	}
	if (!ctx.childScoped && required?.minOutputTokens === undefined && reference?.maxTokens && !(typeof model.maxTokens === "number" && model.maxTokens >= reference.maxTokens)) {
		dimensions.push("output"); detail.output = `below parent baseline ${reference.maxTokens}`;
	}
	if (!ctx.childScoped && required?.inputModalities === undefined && reference?.input?.includes("image") && !model.input?.includes("image")) {
		dimensions.push("modality"); detail.modality = "below parent baseline: image input";
	}
	if (!ctx.childScoped && required?.reasoning === undefined && reference?.reasoning === true && model.reasoning !== true) {
		dimensions.push("modality"); detail.modality = "below parent baseline: reasoning";
	}
	const route = evaluateRoute({ provider: model.provider, model: model.id, now: ctx.timestamp }, ctx.health);
	if (!route.allowed) {
		// Auth-bound routes are authorization failures, not cooldowns: dead
		// keys need re-authorization, never a wait-and-retry.
		if (route.kind === "provider-auth") {
			dimensions.push("authorization"); detail.authorization = `dead credentials (${route.boundBy ?? "provider"})`;
		} else if (route.kind === "quota-rate") {
			dimensions.push("quota"); detail.quota = `rate/quota cooldown (${route.boundBy ?? "provider"})`;
		} else {
			dimensions.push("provider-cooling"); detail["provider-cooling"] = route.boundBy ?? "cooldown";
		}
	}
	const history = ctx.histories.get(model.fullId);
	if (history && history.effectiveSamples >= 4 && history.failureRate > .65) {
		dimensions.push("reliability-history"); detail["reliability-history"] = `${Math.round(history.failureRate * 100)}% recent failures`;
	}
	if (ctx.options?.exclude?.includes(model.fullId)) { dimensions.push("excluded"); detail.excluded = "excluded by caller"; }
	if (findModelExclusion(model.fullId)) { dimensions.push("excluded"); detail.excluded = "model exclusion"; }
	if (ctx.options?.exhaustedProviders?.includes(model.provider)) { dimensions.push("quota"); detail.quota = "provider quota exhausted"; }
	return { route: model.fullId, dimensions: [...new Set(dimensions)], detail };
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
	const gate = buildSelectionGateContext(models, options);
	const reference = gate.reference;
	const evidence = gate.evidence;
	const timestamp = gate.timestamp;
	const health = gate.health;
	const histories = gate.histories;
	// Structured per-candidate rejections, keyed by route. Dimensions stay
	// orthogonal: capacity, tool-wire, cooling, history, exclusion, quota here;
	// free-proof, quality, and price layer on below.
	const rejectionMap = new Map<string, CandidateRejection>();
	const noteRejection = (rejection: CandidateRejection) => {
		if (!rejection.dimensions.length) return;
		const prior = rejectionMap.get(rejection.route);
		if (!prior) { rejectionMap.set(rejection.route, rejection); return; }
		rejectionMap.set(rejection.route, {
			route: rejection.route,
			dimensions: [...new Set([...prior.dimensions, ...rejection.dimensions])],
			detail: { ...prior.detail, ...rejection.detail },
		});
	};
 const { cache, offline } = readRankCache();
 const qualityTask = options?.quality ?? (options?.task ? taskQuality(options.task) : undefined);
	let pool = (models ?? []).filter((model) => {
		const gates = evaluateCandidateGates(model, gate);
		noteRejection(gates);
		return gates.dimensions.length === 0;
	});
	// One evidence snapshot for the whole selection, rather than disk I/O per model.
	const freeReport = describeFreeRoutes(pool, {evidence,requirements:{minContextWindow:MIN_AUTONOMOUS_CONTEXT_TOKENS, toolCalling:gate.effectiveRequirements?.toolCalling !== false}});
 const freeIds = new Set(freeReport.candidates.filter(c=>c.eligible).map(c=>c.route));
 const qualityPool = pool.filter(m=>freeIds.has(m.fullId) || !options?.freeOnly && (isAutonomousMeteredEligible(m,cfg) || subscriptionEligible(m,cfg)));
 const quality = qualityTask ? assessModelQuality(qualityPool,cache?.observations ?? [],qualityTask,reference,timestamp) : undefined;
 const freeByRoute = new Map(freeReport.candidates.map(candidate => [candidate.route, candidate]));
 if (quality) {
	for (const model of pool) {
		const verdict = quality.get(model.fullId);
		if (verdict && !verdict.eligible) {
			noteRejection({ route: model.fullId, dimensions: ["quality-evidence"], detail: { "quality-evidence": verdict.reason } });
		} else if (!verdict && !qualityPool.some(m => m.fullId === model.fullId)) {
			noteRejection({ route: model.fullId, dimensions: ["price"], detail: { price: options?.freeOnly ? "no proven free route" : "no known-affordable price" } });
		}
	}
	pool = pool.filter(m=>quality.get(m.fullId)?.eligible);
 }
	// Bounded decision record for /used, /metrics, and deterministic recovery.
	// Candidates show independent gates (free proof, price, quality, health);
	// rejections carry the orthogonal dimensions collected above.
	const buildDecision = (choice?: string, choiceReason?: string): RouteDecisionRecord => recordRouteDecision({
		...(options?.decision?.taskHash ? { taskHash: options.decision.taskHash } : {}),
		...(options?.decision?.preferenceRole ? { preferenceRole: options.decision.preferenceRole } : {}),
		...(options?.freeOnly === undefined ? {} : { freeOnly: options.freeOnly }),
		...(gate.effectiveRequirements ? { requiredCapabilities: {
			...(gate.effectiveRequirements.minContextWindow === undefined ? {} : { minContextWindow: gate.effectiveRequirements.minContextWindow }),
			...(gate.effectiveRequirements.minOutputTokens === undefined ? {} : { minOutputTokens: gate.effectiveRequirements.minOutputTokens }),
			...(gate.effectiveRequirements.reasoning === undefined ? {} : { reasoning: gate.effectiveRequirements.reasoning }),
			...(options?.child?.contextMode ? { contextMode: options.child.contextMode } : {}),
		} } : {}),
		candidates: (models ?? []).slice(0, 64).map(model => ({
			route: model.fullId,
			free: freeByRoute.get(model.fullId)?.eligible === true,
			...(freeByRoute.get(model.fullId) && !freeByRoute.get(model.fullId)!.eligible ? { freeProof: freeByRoute.get(model.fullId)!.reasons.slice(0, 2).join(", ") } : {}),
			paidEligible: isAutonomousMeteredEligible(model, cfg) || subscriptionEligible(model, cfg),
			...(quality?.get(model.fullId) ? { qualityEvidence: quality.get(model.fullId)!.reason } : {}),
			...(options?.toolWire?.backend ? { backend: options.toolWire.backend } : {}),
			...(options?.toolWire?.compatible ? { toolCompatible: options.toolWire.compatible(model.fullId).ok } : {}),
			healthy: evaluateRoute({ provider: model.provider, model: model.id, now: timestamp }, health).allowed,
		})),
		rejections: [...rejectionMap.values()],
		...(choice ? { choice } : {}),
		...(choiceReason ? { choiceReason } : {}),
		...(reference ? { parentBaseline: reference.fullId } : {}),
	});
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
        return {model:free[0]!.route,explanation:["free-first after task quality, verified free pricing, tool support, capacity and route-health gates",...(quality ? [quality.get(free[0]!.route)!.reason] : ["task quality unspecified; catalog capacity is not a quality measurement"]),"provider reliability and observed response speed do not establish model intelligence"],decision:buildDecision(free[0]!.route,"free-first after task quality gates")};
    }
	if (options?.freeOnly) return undefined;
	const explanation: string[] = [];
	const eligible = pool.filter((model) => {
		if (contextTooSmall(model)) {
			noteRejection({ route: model.fullId, dimensions: ["context"], detail: { context: `below autonomous floor ${MIN_AUTONOMOUS_CONTEXT_TOKENS}` } });
			return false;
		}
		if (isAutonomousMeteredEligible(model, cfg)) {
			const comparable = Number.isFinite(economyComparisonCost(model, options?.workload));
			if (!comparable) noteRejection({ route: model.fullId, dimensions: ["price"], detail: { price: "no finite comparison cost" } });
			return comparable;
		}
		if (subscriptionEligible(model, cfg)) return true;
		noteRejection({ route: model.fullId, dimensions: ["price"], detail: { price: "no known-affordable price" } });
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
    const forecastReady=eligible.filter(model=>isAutonomousMeteredEligible(model,cfg)).every(model=>histories.get(model.fullId)!.effectiveSamples>=6);
    const retryCost=(model:ModelInfo)=>{
        const history=histories.get(model.fullId)!;
        // Observed failures can increase a forecast, never widen price or quality
        // admission. Weak/stale history stays neutral; no exploratory live calls.
        return process.env.PI_LOCAL_INTELLIGENCE!=='off' && forecastReady ? economyComparisonCost(model,options?.workload)/Math.max(.2,1-history.failureRate) : economyComparisonCost(model,options?.workload);
    };
    const compareCost=(a:ModelInfo,b:ModelInfo)=>{
        const left=economyComparisonCost(a,options?.workload),right=economyComparisonCost(b,options?.workload);
        const group=Number(left>cheapestCost*1.1)-Number(right>cheapestCost*1.1);
        return qualityCompare(a.fullId,b.fullId) || group || (process.env.PI_LOCAL_INTELLIGENCE!=='off' && forecastReady ? retryCost(a)-retryCost(b) : 0) || (speedScores.get(a.fullId)??0)-(speedScores.get(b.fullId)??0) || left-right;
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
		return { model: chosen.fullId, explanation, ...(offline ? { offline: true } : {}), decision: buildDecision(chosen.fullId, "cheapest eligible metered route after quality gates") };
	}
	const subscription = eligible
		.filter((model) => subscriptionEligible(model, cfg))
		.sort((a, b) => a.fullId.localeCompare(b.fullId))[0];
	if (subscription) {
		explanation.push(`no metered route within the automatic budget remains; using the declared subscription route ${subscription.fullId}`);
		return { model: subscription.fullId, explanation, ...(offline ? { offline: true } : {}), decision: buildDecision(subscription.fullId, "declared subscription fallback") };
	}
	return undefined;
}

/**
 * Structured rejections for a failed (or hypothetical) selection: the same
 * shared hard gates plus free-proof, quality, and price layers. Recovery
 * reads these dimensions instead of parsing prose.
 */
export function describeSelectionRejections(
	models: ModelInfo[] | undefined,
	cfg: ModelEconomyConfig,
	options: AffordableSelectionOptions = {},
): { rejections: CandidateRejection[]; decision: RouteDecisionRecord } {
	const gate = buildSelectionGateContext(models, options);
	const candidates = models ?? [];
	const rejectionMap = new Map<string, CandidateRejection>();
	const note = (rejection: CandidateRejection) => {
		if (!rejection.dimensions.length) return;
		const prior = rejectionMap.get(rejection.route);
		rejectionMap.set(rejection.route, prior ? {
			route: rejection.route,
			dimensions: [...new Set([...prior.dimensions, ...rejection.dimensions])],
			detail: { ...prior.detail, ...rejection.detail },
		} : rejection);
	};
	for (const model of candidates) note(evaluateCandidateGates(model, gate));
	const hardPool = candidates.filter(model => !rejectionMap.has(model.fullId));
	const freeReport = describeFreeRoutes(candidates, {
		evidence: gate.evidence,
		requirements: { minContextWindow: MIN_AUTONOMOUS_CONTEXT_TOKENS, toolCalling: gate.effectiveRequirements?.toolCalling !== false },
		now: gate.timestamp,
	});
	const freeByRoute = new Map(freeReport.candidates.map(candidate => [candidate.route, candidate]));
	const freeIds = new Set(freeReport.candidates.filter(candidate => candidate.eligible).map(candidate => candidate.route));
	const { cache } = readRankCache();
	const qualityTask = options.quality ?? (options.task ? taskQuality(options.task) : undefined);
	const qualityPool = hardPool.filter(model => freeIds.has(model.fullId) || !options.freeOnly && (isAutonomousMeteredEligible(model, cfg) || subscriptionEligible(model, cfg)));
	const quality = qualityTask ? assessModelQuality(qualityPool, cache?.observations ?? [], qualityTask, gate.reference, gate.timestamp) : undefined;
	for (const model of hardPool) {
		const verdict = quality?.get(model.fullId);
		if (verdict && !verdict.eligible) {
			note({ route: model.fullId, dimensions: ["quality-evidence"], detail: { "quality-evidence": verdict.reason } });
		}
		const free = freeByRoute.get(model.fullId);
		if (free?.free && !free.eligible) {
			note({ route: model.fullId, dimensions: ["price"], detail: { price: `free proof failed: ${free.reasons.slice(0, 2).join(", ")}` } });
		}
		if (!options.freeOnly && !contextTooSmall(model) && !isAutonomousMeteredEligible(model, cfg) && !subscriptionEligible(model, cfg) && !free?.eligible) {
			note({ route: model.fullId, dimensions: ["price"], detail: { price: "no known-affordable price" } });
		}
		if (options.freeOnly && free && !free.eligible) {
			note({ route: model.fullId, dimensions: ["price"], detail: { price: "free-only selection without proven free route" } });
		}
	}
	const decision = recordRouteDecision({
		...(options.decision?.taskHash ? { taskHash: options.decision.taskHash } : {}),
		...(options.decision?.preferenceRole ? { preferenceRole: options.decision.preferenceRole } : {}),
		...(options.freeOnly === undefined ? {} : { freeOnly: options.freeOnly }),
		candidates: candidates.slice(0, 64).map(model => ({
			route: model.fullId,
			free: freeIds.has(model.fullId),
			paidEligible: isAutonomousMeteredEligible(model, cfg) || subscriptionEligible(model, cfg),
			...(quality?.get(model.fullId) ? { qualityEvidence: quality.get(model.fullId)!.reason } : {}),
			healthy: evaluateRoute({ provider: model.provider, model: model.id, now: gate.timestamp }, gate.health).allowed,
		})),
		rejections: [...rejectionMap.values()],
		...(gate.reference ? { parentBaseline: gate.reference.fullId } : {}),
	});
	return { rejections: [...rejectionMap.values()], decision };
}

/**
 * Explain a failed autonomous selection without changing the selection or
 * performing any refresh/network work. This is intentionally candidate-level:
 * an aggregate "no route" message is not actionable when a catalog contains
 * many free routes that were rejected by different gates.
 */
export function formatAffordableSelectionDiagnostics(
	models: ModelInfo[] | undefined,
	cfg: ModelEconomyConfig,
	options: AffordableSelectionOptions = {},
): string {
	const candidates = models ?? [];
	if (!candidates.length) return "No registered candidates were available for inspection.";
	// Shared gates: the prose below renders the same structured dimensions
	// that selection recorded, so diagnostics cannot drift from the verdict.
	const { rejections } = describeSelectionRejections(models, cfg, options);
	const byRoute = new Map(rejections.map(rejection => [rejection.route, rejection]));
	const gate = buildSelectionGateContext(models, options);
	const freeReport = describeFreeRoutes(candidates, {
		evidence: gate.evidence,
		requirements: { minContextWindow: MIN_AUTONOMOUS_CONTEXT_TOKENS, toolCalling: gate.effectiveRequirements?.toolCalling !== false },
		now: gate.timestamp,
	});
	const freeById = new Map(freeReport.candidates.map(candidate => [candidate.route, candidate]));
	const rows = candidates.map(model => {
		const structured = byRoute.get(model.fullId);
		const reasons = structured?.dimensions.map(dimension => {
			const text = structured.detail[dimension];
			return text ? `${dimension} (${text})` : dimension;
		}) ?? [];
		return { model, reasons: [...new Set(reasons)] };
	});
	const freeRows = rows.filter(row => freeById.get(row.model.fullId)?.free);
	const render = (row: { model: ModelInfo; reasons: string[] }) => `${row.model.fullId}: ${row.reasons.length ? row.reasons.join(", ") : "passed local gates; another compounded constraint rejected the pool"}`;
	const shown = freeRows.slice(0, 12).map(render);
	const more = freeRows.length > shown.length ? `; +${freeRows.length - shown.length} more free candidates` : "";
	const freeSummary = freeRows.length
		? `${freeRows.length} candidate(s) had free-route evidence${shown.length ? ` — ${shown.join("; ")}` : ""}${more}`
		: "no candidate had current free-route evidence";
	return `Free-route diagnostics (${freeReport.state}): ${freeSummary}. Catalog category: ${freeReport.category ?? "none"}. Selection gates are offline; quality labels distinguish unknown evidence from measured rejection.`;
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
  // overwrite newer evidence produced by another live session. A stale lock
  // is dead (a crash between acquire and release) and is taken over so one
  // crashed publisher cannot wedge every later refresh.
  const lockPath = `${filePath}.publish-lock`;
  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let lockAgeMs = Number.POSITIVE_INFINITY;
    try { lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { /* vanished: retry below */ }
    if (lockAgeMs <= PUBLISH_LOCK_STALE_MS) return { ok: false, reason: "another session is publishing model ranking evidence" };
    fs.rmSync(lockPath, { recursive: true, force: true });
    try { fs.mkdirSync(lockPath); }
    catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError;
      return { ok: false, reason: "another session is publishing model ranking evidence" };
    }
  }
  lock = lockPath;
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
