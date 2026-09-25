import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "./pi-spawn.ts";
import { readHealth, economyRateIdentity, type ProviderHealthState } from "./provider-health.ts";
import { splitKnownThinkingSuffix, toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { getAgentDir, PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import { isProvenFreeRoute, capFreeRequest, FREE_BASE_URL } from "./free-route-evidence.ts";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, waitForFileSystemRetry } from "../../shared/file-system-retry.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { sessionObservability } from "../../../../lib/session-observability.ts";

/**
 * Cost-aware subagent economy policy (2026-09-22 relaxed).
 *
 * Intent: do not micro-manage $/M matching. Automatic selection only avoids
 * provable traps (zero-price placeholders, absurd rates). Unknown price is
 * eligible — spend is bounded by runaway circuit breakers
 * (`child-circuit-breakers.ts`, per-child `maxCostUsd`) and request budgets,
 * not by proving every route is under $1/M. Manual routes are always honored.
 *
 * Deterministic, no timers, no network. Config precedence:
 *   1. $PI_SUBAGENTS_ECONOMY_CONFIG — JSON fixture (tests / operators)
 *   2. the canonical user settings.json `subagents.economy` object
 *   3. built-in defaults (below).
 */

export interface ModelEconomyConfig {
 /** Optional operational exception, never an assertion of task quality. Explicit base caps disable it unless explicitly configured. */
 operationalPremiumMaxPerMillion?: number;
	enabled: boolean;
	/** USD per 1M input tokens ceiling for automatic selection. */
	maxInputPerMillion: number;
	/** USD per 1M output tokens ceiling for automatic selection. */
	maxOutputPerMillion: number;
	/** Providers whose plans are subscriptions (not metered) — e.g. openai-codex. */
	subscriptionProviders: string[];
	/** When true, affordable openrouter child requests carry provider.max_price caps. */
	openRouterMaxPrice: boolean;
	/** Exact 'provider/id' routes a human authorized above the ceiling. */
	allowExpensive: string[];
	/** Path the configuration was loaded from, for diagnostics. */
	filePath?: string;
}

export interface ModelEconomyRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type ModelEconomyVerdict = "affordable" | "expensive" | "zero-placeholder" | "unknown-price" | "subscription";

export interface ModelEconomyClassification {
	verdict: ModelEconomyVerdict;
	/** True when the route is exact-human-authorized in `allowExpensive`. */
	authorized: boolean;
	/** True when cost metadata declares long-context tiers with a worst case above the cap. */
	tiered?: boolean;
	/** True when metered rates are missing — eligible under the relaxed economy. */
	priceUnproven?: boolean;
	/** Worst-case (base + tiers) rates, USD per 1M tokens, when price metadata exists. */
	rates?: ModelEconomyRates;
	reason?: string;
}

export const ECONOMY_CONFIG_ENV = "PI_SUBAGENTS_ECONOMY_CONFIG";
const DEFAULT_SUBSCRIPTION_PROVIDERS = ["openai-codex"];

function defaultConfig(): ModelEconomyConfig {
	return {
		enabled: true,
		// Relaxed ceilings: these catch absurd rates, not ordinary commercial
		// models. Runaway spend is owned by child circuit breakers.
		operationalPremiumMaxPerMillion: undefined,
		maxInputPerMillion: 50,
		maxOutputPerMillion: 50,
		subscriptionProviders: [...DEFAULT_SUBSCRIPTION_PROVIDERS],
		// Keep free-route max_price=0 binding (prevents accidental paid fallback
		// on a proven-free route). Do not pin metered children to $/M caps.
		openRouterMaxPrice: true,
		allowExpensive: [],
	};
}

function positiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateAllowExpensive(raw: unknown): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string")) {
		throw new Error(`subagents.economy.allowExpensive must be an array of 'provider/id' strings.`);
	}
	return [...raw];
}

/**
 * Validate a raw economy config object and merge it over the built-in defaults.
 * Throws with an actionable message when a numeric field is not a positive
 * finite number.
 */
export function parseModelEconomyConfig(raw: unknown, options?: { filePath?: string }): ModelEconomyConfig {
	const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const config = defaultConfig();
	if (source.enabled !== undefined) {
		if (typeof source.enabled !== "boolean")
			throw new Error(`subagents.economy.enabled must be a boolean; got ${JSON.stringify(source.enabled)}.`);
		config.enabled = source.enabled;
	}
	for (const key of ["maxInputPerMillion", "maxOutputPerMillion"] as const) {
		const value = source[key];
		if (value === undefined) continue;
		if (!positiveFinite(value))
			throw new Error(`subagents.economy.${key} must be a positive finite number (USD per million tokens); got ${JSON.stringify(value)}.`);
		config[key] = value;
	}
	if (source.subscriptionProviders !== undefined) {
		if (!Array.isArray(source.subscriptionProviders) || !source.subscriptionProviders.every((p) => typeof p === "string"))
			throw new Error(`subagents.economy.subscriptionProviders must be an array of provider names.`);
		config.subscriptionProviders = [...source.subscriptionProviders];
	}
	if (source.openRouterMaxPrice !== undefined) {
		if (typeof source.openRouterMaxPrice !== "boolean")
			throw new Error(`subagents.economy.openRouterMaxPrice must be a boolean.`);
		config.openRouterMaxPrice = source.openRouterMaxPrice;
	}
    if (source.maxInputPerMillion !== undefined || source.maxOutputPerMillion !== undefined) config.operationalPremiumMaxPerMillion = undefined;
    if (source.operationalPremiumMaxPerMillion !== undefined) {
        if (!positiveFinite(source.operationalPremiumMaxPerMillion) || source.operationalPremiumMaxPerMillion > 3) throw new Error("subagents.economy.operationalPremiumMaxPerMillion must be positive and at most 3.");
        config.operationalPremiumMaxPerMillion = source.operationalPremiumMaxPerMillion;
    }
	config.allowExpensive = validateAllowExpensive(source.allowExpensive);
	config.filePath = options?.filePath;
	return config;
}

let configCache: ModelEconomyConfig | undefined;
let configCacheKey: string | undefined;
let configCacheStamp: string | undefined;

function configSourceStamp(filePath: string): string {
	try {
		const stat = fs.statSync(filePath);
		return `${filePath}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
	} catch {
		return `${filePath}:missing`;
	}
}

/** A config file that exists but cannot be read or parsed. Unlike a
 * missing file (clean "no operator config" signal), this must never silently
 * relax operator-tightened ceilings back to defaults. */
export class EconomyConfigReadError extends Error {
	readonly filePath: string;
	readonly code?: string;
	constructor(filePath: string, message: string, code?: string) {
		super(`${filePath}: ${message}`);
		this.name = "EconomyConfigReadError";
		this.filePath = filePath;
		this.code = code;
	}
}

export interface EconomyConfigErrorState {
	at: number;
	filePath: string;
	message: string;
}

let lastConfigError: EconomyConfigErrorState | undefined;

/** The most recent config-file read failure, cleared by a successful load. */
export function lastModelEconomyConfigError(): EconomyConfigErrorState | undefined {
	return lastConfigError;
}

function noteHealth(kind: string, data: Record<string, unknown>): void {
	try { sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.(kind, data); } catch { /* telemetry is optional */ }
}

function recordConfigError(error: EconomyConfigReadError, lastGood: boolean): void {
	const message = error.code ?? error.message.slice(0, 160);
	if (lastConfigError?.filePath === error.filePath && lastConfigError?.message === message) return;
	lastConfigError = { at: Date.now(), filePath: error.filePath, message };
	noteHealth("subagent.economy-config", { filePath: error.filePath, error: message, lastGood });
}

function readJsonObjectFile(filePath: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
		throw new EconomyConfigReadError(filePath, "cannot read config file", (error as NodeJS.ErrnoException)?.code);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new EconomyConfigReadError(filePath, "invalid JSON", "EJSONPARSE");
	}
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function canonicalSettingsEconomy(): { economy: unknown; filePath: string } {
	const filePath = path.join(getAgentDir(), "settings.json");
	const settings = readJsonObjectFile(filePath);
	const subagents = settings.subagents && typeof settings.subagents === "object" ? (settings.subagents as Record<string, unknown>) : {};
	return { economy: subagents.economy, filePath };
}

/** Load and cache the effective economy config (see precedence at the top).
 * An unreadable/corrupt config file fails closed to the last-good config
 * (or defaults on first load) and records the failure; invalid VALUES still
 * throw with the actionable validation message, as before. */
export function loadModelEconomyConfig(): ModelEconomyConfig {
	const envPath = process.env[ECONOMY_CONFIG_ENV]?.trim() || undefined;
	const key = envPath ?? "";
	const sourcePath = envPath ?? path.join(getAgentDir(), "settings.json");
	const stamp = configSourceStamp(sourcePath);
	if (configCache && configCacheKey === key && configCacheStamp === stamp) return configCache;
	let economy: unknown;
	let filePath: string;
	try {
		({ economy, filePath } = envPath
			? { economy: readJsonObjectFile(envPath), filePath: envPath }
			: canonicalSettingsEconomy());
	} catch (error) {
		if (!(error instanceof EconomyConfigReadError)) throw error;
		const lastGood = Boolean(configCache && configCacheKey === key);
		recordConfigError(error, lastGood);
		if (lastGood) return configCache!;
		configCache = parseModelEconomyConfig(undefined, { filePath: error.filePath });
		configCacheKey = key;
		configCacheStamp = stamp;
		return configCache;
	}
	configCache = parseModelEconomyConfig(economy, { filePath });
	configCacheKey = key;
	configCacheStamp = stamp;
	lastConfigError = undefined;
	return configCache;
}

/** Drop any cached economy config so the next load re-reads files/env. */
export function clearModelEconomyConfigCache(): void {
	configCache = undefined;
	configCacheKey = undefined;
	configCacheStamp = undefined;
	healthSnapshot = undefined;
	lastConfigError = undefined;
}

/** Strip a known thinking suffix; used for exact-route comparisons. */
function baseModelOf(route: string): string {
	return splitKnownThinkingSuffix(route.trim()).baseModel;
}

export function isAuthorizedExpensiveModel(fullId: string, cfg: ModelEconomyConfig): boolean {
	const base = baseModelOf(fullId);
	return cfg.allowExpensive.some((entry) => baseModelOf(entry) === base);
}

interface RateSet extends ModelEconomyRates {
	tiers?: Array<ModelEconomyRates & { inputTokensAbove?: number }>;
}

function worstCaseRates(cost: RateSet | undefined): ModelEconomyRates | undefined {
	if (!cost) return undefined;
	if (![cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every((v) => Number.isFinite(v) && v >= 0)) return undefined;
	const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
	if (tiers.some((tier) => !tier || [tier.input, tier.output, tier.cacheRead, tier.cacheWrite].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0)))) return undefined;
	const rates: ModelEconomyRates = { ...cost };
	for (const tier of tiers) {
		rates.input = Math.max(rates.input, Number.isFinite(tier.input) ? tier.input : 0);
		rates.output = Math.max(rates.output, Number.isFinite(tier.output) ? tier.output : 0);
		rates.cacheRead = Math.max(rates.cacheRead, Number.isFinite(tier.cacheRead) ? tier.cacheRead : 0);
		rates.cacheWrite = Math.max(rates.cacheWrite, Number.isFinite(tier.cacheWrite) ? tier.cacheWrite : 0);
	}
	return rates;
}

export const OPERATIONAL_ECONOMY_ROUTES_ENV = "PI_SUBAGENT_ECONOMY_BOUND_ROUTES";
const operationalAdmissions = new Set<string>();
/** Restriction-only launch marker: never authorizes a premium without current store evidence. */
function inheritedOperationalRoutes(): string[] {
 try {
  const raw=process.env[OPERATIONAL_ECONOMY_ROUTES_ENV]??"[]";
  if(raw.length>65536)return [];
  const routes=JSON.parse(raw);
  return Array.isArray(routes)&&routes.length<=128&&routes.every(route=>typeof route==='string'&&route.length<=256)?routes:[];
 } catch {return [];}
}
export function operationalAdmissionRoutes(routes?: readonly string[]): string {
 const admitted=new Set([...inheritedOperationalRoutes(),...operationalAdmissions].map(baseModelOf));
 return JSON.stringify((routes ?? [...admitted]).map(baseModelOf).filter(route=>admitted.has(route)).slice(0,routes?32:128));
}
function operationalRouteWasAdmitted(route:string): boolean {
 const base=baseModelOf(route);
 return [...operationalAdmissions,...inheritedOperationalRoutes()].some(admitted=>baseModelOf(admitted)===base);
}
let healthSnapshot: {at:number; state:ProviderHealthState} | undefined;
function economyHealth(): ProviderHealthState {
 const now=Date.now();
 if (!healthSnapshot || now<healthSnapshot.at || now-healthSnapshot.at>100) healthSnapshot={at:now,state:readHealth()};
 return healthSnapshot.state;
}

/** Recent SDK usage/cost observations, not final provider billing, semantic quality or a cache guarantee. */
export function operationalEconomyQualification(model: ModelInfo | undefined, cfg: ModelEconomyConfig): {maxPerMillion:number; reason:string} | undefined {
 if (!model?.cost || model.provider !== "openrouter" || !cfg.openRouterMaxPrice || !positiveFinite(cfg.operationalPremiumMaxPerMillion) || cfg.operationalPremiumMaxPerMillion>3) return;
 if (model.baseUrl && model.baseUrl.replace(/\/+$/, "") !== FREE_BASE_URL) return;
 const ceiling=cfg.operationalPremiumMaxPerMillion, rates=worstCaseRates(model.cost as RateSet);
 if (!rates || [rates.input,rates.output,rates.cacheRead,rates.cacheWrite].some(n=>n>ceiling)) return;
 if (rates.input<=cfg.maxInputPerMillion && rates.output<=cfg.maxOutputPerMillion) return;
 const provider=economyHealth().providers[model.provider], health=provider?.models[model.id];
 if (!health || health.failure || provider.failure || health.cooldownUntil>Date.now() || provider.cooldownUntil>Date.now()) return;
 const fingerprint=economyRateIdentity(model.cost,model.baseUrl,model.api);
 const now=Date.now();
 const samples=Array.isArray(health.economyUsage) ? health.economyUsage.slice(-50).filter(s=>s && Number.isFinite(s.at) && s.at<=now && now-s.at<=300_000 && s.rates===fingerprint) : [];
 if (samples.length<3) return;
 const records=[];
 for (const sample of samples) {
  if (![sample.input,sample.output,sample.cacheRead,sample.cacheWrite].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100_000_000) || !Number.isFinite(sample.costUsd) || sample.costUsd<0) return;
  const context=sample.input+sample.cacheRead+sample.cacheWrite;
  if(context<8192) return;
  const estimate=(sample.input*rates.input+sample.output*rates.output+sample.cacheRead*rates.cacheRead+sample.cacheWrite*rates.cacheWrite)/1e6;
  const baseline=(context*cfg.maxInputPerMillion+sample.output*cfg.maxOutputPerMillion)/1e6;
  const cold=(context*rates.input+sample.output*rates.output)/1e6;
  if (!(baseline>0) || Math.max(estimate,sample.costUsd)>baseline*.65) return;
  records.push({context,output:sample.output,cacheFraction:sample.cacheRead/context,cold,baseline});
 }
 const coldSafe=records.every(r=>r.cold<=r.baseline*.65);
 if(!coldSafe) {
  // Forecast, NOT a confidence interval: consecutive cache shares are correlated.
  // Stress the worst observed hit share and charge one complete miss per 20 calls.
  if(records.length<20 || Math.max(...records.map(r=>r.context))>Math.min(...records.map(r=>r.context))*2) return;
  const hitShare=Math.max(0,Math.min(...records.map(r=>r.cacheFraction))-(records.length>=50?.1:.2));
  if(!records.every(r=>{
   const warm=(r.context*((1-hitShare)*rates.input+hitShare*rates.cacheRead)+r.output*rates.output)/1e6;
   return (r.cold+19*warm)/20<=r.baseline*.65;
  })) return;
 }
 if(operationalAdmissions.size>=128)operationalAdmissions.delete(operationalAdmissions.values().next().value!);
 operationalAdmissions.add(model.fullId);
 return {maxPerMillion:ceiling,reason:`operational cost qualification: ${samples.length} recent same-price usages; ${coldSafe ? "cold-input comparison" : "cache FORECAST with reduced worst observed hit share and one cold request per 20 calls"} within 65% of base-budget comparison; task quality and future cache hits are not established`};
}

/** Compare only measured response times for similar observed workloads; unknown is neutral. */
export function compareObservedEconomySpeed(a: ModelInfo, b: ModelInfo): number {
 const read=(model:ModelInfo)=>{
  const health=economyHealth().providers[model.provider]?.models[model.id];
  const fingerprint=economyRateIdentity(model.cost??{},model.baseUrl,model.api);
  const now=Date.now();
  const samples=Array.isArray(health?.economyUsage)?health.economyUsage.filter(s=>s && s.rates===fingerprint && Number.isFinite(s.at) && s.at<=now && now-s.at<=300_000
    && typeof s.elapsedMs==='number' && Number.isFinite(s.elapsedMs) && s.elapsedMs>0 && s.elapsedMs<=600_000
    && [s.input,s.output,s.cacheRead,s.cacheWrite].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100_000_000)).slice(-8):[];
  if(samples.length<3)return;
  const contexts=samples.map(s=>s.input+s.cacheRead+s.cacheWrite), outputs=samples.map(s=>s.output);
  if(Math.max(...contexts)>Math.max(1,Math.min(...contexts))*1.2 || Math.max(...outputs)>Math.max(1,Math.min(...outputs))*1.2)return;
  const times=samples.map(s=>s.elapsedMs!).sort((x,y)=>x-y);
  return {context:contexts.reduce((x,y)=>x+y,0)/samples.length,output:outputs.reduce((x,y)=>x+y,0)/samples.length,ms:times[Math.floor(times.length/2)]!};
 };
 const left=read(a),right=read(b);
 if(!left||!right || Math.max(left.context,right.context)>Math.max(1,Math.min(left.context,right.context))*1.2 || Math.max(left.output,right.output)>Math.max(1,Math.min(left.output,right.output))*1.2)return 0;
 if(Math.max(left.ms,right.ms)<Math.min(left.ms,right.ms)*1.2)return 0;
 return left.ms-right.ms;
}

/**
 * Classify a single route for economy policy. `model` is the registry entry for
 * `fullId` (undefined when the route is not in the active registry).
 */
export function classifyModelEconomy(
	fullId: string,
	model: ModelInfo | undefined,
	cfg: ModelEconomyConfig,
): ModelEconomyClassification {
	const provider = model?.provider ?? baseModelOf(fullId).split("/")[0] ?? "";
	const authorized = isAuthorizedExpensiveModel(fullId, cfg);
	if (isProvenFreeRoute(model)) return { verdict: "affordable", authorized, rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reason: "fresh official exact-route free price evidence" };
	if (cfg.subscriptionProviders.includes(provider)) {
		return { verdict: "subscription", authorized };
	}
	const cost = model?.cost;
	if (!cost || !Number.isFinite(cost.input) || !Number.isFinite(cost.output)) {
		// Unknown price is eligible under the relaxed economy. Runaway breakers
		// bound spend; refusing unpriced routes just starved good helpers.
		return {
			verdict: "affordable",
			authorized,
			priceUnproven: true,
			reason: "no metered price metadata; spend bounded by circuit breakers rather than price proof",
		};
	}
	const rates = worstCaseRates(cost as RateSet);
	const tiered = Boolean(Array.isArray(cost.tiers) && cost.tiers.length > 0);
	if (!rates) {
		return {
			verdict: "affordable",
			authorized,
			priceUnproven: true,
			reason: "incomplete metered price metadata; spend bounded by circuit breakers rather than price proof",
		};
	}
	if (rates.input === 0 && rates.output === 0) {
		const result: ModelEconomyClassification = {
			verdict: "zero-placeholder",
			authorized,
			rates,
			reason: "zero price is a placeholder, not proof the route is free/cheap",
		};
		if (authorized) return { ...result, verdict: "affordable" };
		return result;
	}
	const aboveCap = rates.input > cfg.maxInputPerMillion || rates.output > cfg.maxOutputPerMillion;
	if (aboveCap) {
		const result: ModelEconomyClassification = {
			verdict: "expensive",
			authorized,
			...(tiered ? { tiered: true } : {}),
			rates,
		};
		if (authorized) return { ...result, verdict: "affordable" };
		return result;
	}
	return { verdict: "affordable", authorized, ...(tiered ? { tiered: true } : {}), rates };
}

/** Autonomously eligible under the relaxed economy: reject only zero-price
 * placeholders and absurd above-cap rates. Unknown/unproven price is allowed
 * (circuit breakers own runaway spend). Authorization does NOT widen the
 * autonomous pool — allowlisted routes only pass explicit use. */
export function isAutonomousMeteredEligible(model: ModelInfo | undefined, cfg: ModelEconomyConfig): boolean {
	if (isProvenFreeRoute(model)) return true;
	if (!model?.cost || !Number.isFinite(model.cost.input) || !Number.isFinite(model.cost.output)) return true;
	if (model.cost.input === 0 && model.cost.output === 0 && !(Array.isArray(model.cost.tiers) && model.cost.tiers.length > 0)) return false;
	const rates = worstCaseRates(model.cost as RateSet);
	if (!rates) return true;
	return rates.input <= cfg.maxInputPerMillion && rates.output <= cfg.maxOutputPerMillion;
}

/** Explicit token accounting: cache buckets are disjoint from uncached input.
 * This is a conditional estimate, never a promise of future cache hits. */
export interface EconomyWorkload {
 inputTokens: number;
 outputTokens: number;
 cacheReadTokens?: number;
 cacheWriteTokens?: number;
}
export function estimateEconomyCost(model: ModelInfo, workload: EconomyWorkload): number | undefined {
 const counts = [workload.inputTokens, workload.outputTokens, workload.cacheReadTokens ?? 0, workload.cacheWriteTokens ?? 0];
 if (counts.some(n => !Number.isSafeInteger(n) || n < 0 || n > 100_000_000)) return;
 const rates = worstCaseRates(model.cost as RateSet | undefined);
 if (!rates || (rates.input === 0 && rates.output === 0 && !isProvenFreeRoute(model))) return;
 // Worst-case tiers prevent an incomplete context estimate understating price.
 const total = (counts[0] * rates.input + counts[1] * rates.output + counts[2] * rates.cacheRead + counts[3] * rates.cacheWrite) / 1_000_000;
 return Number.isFinite(total) ? total : undefined;
}

/** No guessed hit rate: default comparison prices one input and one output token. */
export function economyComparisonCost(model: ModelInfo, workload?: EconomyWorkload): number {
 return estimateEconomyCost(model, workload ?? {inputTokens:1, outputTokens:1}) ?? Infinity;
}

/** Affordable metered alternatives (sorted cheapest-first) for error messages. */
export function economyAffordableAlternatives(models: ModelInfo[] | undefined, cfg: ModelEconomyConfig, excludeFullId?: string): string[] {
	if (!models) return [];
	return models
		.filter((model) => {
			if (excludeFullId && model.fullId === baseModelOf(excludeFullId)) return false;
			return isAutonomousMeteredEligible(model, cfg);
		})
		.sort((a, b) => {
			const aCost = economyComparisonCost(a);
			const bCost = economyComparisonCost(b);
			return aCost !== bCost ? aCost - bCost : a.fullId.localeCompare(b.fullId);
		})
		.map((model) => model.fullId);
}

function formatCaps(cfg: ModelEconomyConfig): string {
	return `$${cfg.maxInputPerMillion}/M input / $${cfg.maxOutputPerMillion}/M output`;
}

/** Actionable hard-error message for a blocked explicit/automatic expensive request. */
export function formatEconomyBlockedMessage(fullId: string, classification: ModelEconomyClassification, cfg: ModelEconomyConfig, alternatives: string[]): string {
	const rates = classification.rates ? ` Route: $${classification.rates.input}/M input, $${classification.rates.output}/M output${classification.tiered ? " (worst-case tier)" : ""}.` : " Price is not verified.";
	return [
		`[pi-subagents] economy policy blocked '${baseModelOf(fullId)}' before inference. Budget: ${formatCaps(cfg)}.${rates}`,
		"Retry only this child with model: inherit for budget-aware selection, or select a listed eligible route with the required capabilities. Keep successful siblings. Do not repeat the same blocked route or change the budget automatically.",
		alternatives.length ? `Within-budget price candidates (verify capabilities/scope): ${alternatives.slice(0, 3).join(", ")}.` : "No known within-budget metered alternative was found.",
		`To permit this exact route, use the human-authorized command: /subagents-economy allow ${baseModelOf(fullId)}.`,
	].join(" ");
}

/** Fail-closed message when an inherited expensive route has no affordable replacement. */
export function formatEconomyNoRouteMessage(fullId: string, cfg: ModelEconomyConfig): string {
	return [
		`[pi-subagents] economy policy blocked inheriting '${baseModelOf(fullId)}' for a subagent: no route with a known price within the automatic budget (${formatCaps(cfg)}) is available.`,
		`Authorize the exact route (/subagents-economy allow ${baseModelOf(fullId)}) or make an affordable metered model available in the registry.`,
	].join(" ");
}

/** Warning for an explicitly configured subagent primary that exceeds the caps. */
export function formatEconomyConfiguredWarning(fullId: string, cfg: ModelEconomyConfig): string {
	return `[pi-subagents] economy: configured subagent primary '${baseModelOf(fullId)}' exceeds the automatic budget (${formatCaps(cfg)}); honoring the configured route.`;
}

/** Warning for an explicitly requested model that exceeds the caps; manual selection is exempt. */
export function formatEconomyExplicitWarning(fullId: string, cfg: ModelEconomyConfig): string {
	return `[pi-subagents] economy: explicitly requested '${baseModelOf(fullId)}' exceeds the automatic budget (${formatCaps(cfg)}); honoring the manual selection.`;
}

/** Warning for routes that are honored/kept even though their price is unknown. */
export function formatEconomyUnknownWarning(fullId: string, cfg: ModelEconomyConfig): string {
	return `[pi-subagents] economy: '${baseModelOf(fullId)}' has no metered price metadata, so its cost cannot be proven to stay within the automatic budget (${formatCaps(cfg)}); honoring the user route.`;
}

function canonicalSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

/** Use Pi's own lock protocol so economy commands also serialize with core
 * settings saves. Resolve its bundled library only when a write is requested. */
function withSettingsUpdateLock<T>(filePath: string, operation: () => T): T {
	const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] || resolvePiPackageRoot() || resolveInstalledPiPackageRoot();
	const require = createRequire(packageRoot ? path.join(packageRoot, "package.json") : import.meta.url);
	const lockfile = require("proper-lockfile") as { lockSync(path: string, options: { realpath: boolean }): () => void };
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	let release: (() => void) | undefined;
	for (let attempt = 0; !release; attempt++) {
		try { release = lockfile.lockSync(filePath, { realpath: false }); }
		catch (error) {
			const delay = DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[attempt];
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || delay === undefined) throw error;
			waitForFileSystemRetry(delay);
		}
	}
	try { return operation(); }
	finally { release(); }
}

function settingsObjectForUpdate(raw: unknown, label: string): Record<string, unknown> {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error(`Cannot update economy authorization: ${label} must be a JSON object; settings were not changed.`);
	return { ...(raw as Record<string, unknown>) };
}

function readSettingsForUpdate(filePath: string): Record<string, unknown> {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot update economy authorization: settings file '${filePath}' could not be read as JSON; settings were not changed.`);
	}
	return settingsObjectForUpdate(raw, "settings");
}

/**
 * Allow or revoke an exact 'provider/id' expensive route in the canonical user
 * settings.json (`subagents.economy.allowExpensive`), preserving every other
 * key. Returns the resulting allow-list and the written file path.
 */
export function setAuthorizedExpensiveModel(route: string, action: "allow" | "revoke"): { allowExpensive: string[]; filePath: string } {
	const base = baseModelOf(route);
	const slashIndex = base.indexOf("/");
	const validRoute = slashIndex > 0 && slashIndex < base.length - 1 && !/[\s:]/.test(base);
	if (!validRoute) {
		throw new Error(`Economy allow/revoke requires an exact 'provider/id' entry (got '${route}').`);
	}
	const filePath = canonicalSettingsPath();
	return withSettingsUpdateLock(filePath, () => {
		// Tolerant reads are appropriate for policy defaults, never for updates:
		// a malformed file or nested object must not erase unrelated settings.
		const settings = readSettingsForUpdate(filePath);
		const subagents = settingsObjectForUpdate(settings.subagents, "subagents");
		const economy = settingsObjectForUpdate(subagents.economy, "subagents.economy");
		const allowExpensive = validateAllowExpensive(economy.allowExpensive);
		let changed = false;
		if (action === "allow" && !allowExpensive.some((entry) => baseModelOf(entry) === base)) {
			allowExpensive.push(base);
			changed = true;
		} else if (action === "revoke") {
			const next = allowExpensive.filter((entry) => baseModelOf(entry) !== base);
			changed = next.length !== allowExpensive.length;
			allowExpensive.length = 0;
			allowExpensive.push(...next);
		}
		if (changed) {
			subagents.economy = { ...economy, allowExpensive };
			settings.subagents = subagents;
			writePrivateAtomicJson(filePath, settings);
			// Invalidate only after the complete atomic replacement succeeds.
			clearModelEconomyConfigCache();
		}
		return { allowExpensive: [...allowExpensive], filePath };
	});
}

type HookHandler = (args: { payload?: unknown }, ctx: unknown) => Promise<unknown> | unknown;
type EconomyHookPi = { on: (event: string, handler: HookHandler) => void };

interface HookContext {
	model?: Omit<ModelInfo, "fullId">;
	modelRegistry?: { getAvailable?: () => ModelInfo[] | undefined };
}

/**
 * Register the openrouter `provider.max_price` injection hook for subagent
 * children or the root recovery owner's exact automatic route. Manual root
 * selections are untouched. Known affordable routes receive the configured
 * caps; proven free routes receive zero caps. Existing lower caps win.
 * Exact human-authorized metered routes keep their explicit endpoint policy;
 * applying the automatic ceiling again would contradict admission authorization.
 */
export function registerEconomyRequestHook(pi: EconomyHookPi, options: { automaticRoute?: () => string | undefined } = {}): void {
	pi.on("before_provider_request", async (args, ctx) => {
		const child = process.env.PI_SUBAGENT_CHILD === "1";
		const automaticRoute = options.automaticRoute?.();
		if (!child && !automaticRoute) return undefined;
		const cfg = loadModelEconomyConfig();
		const payload = args?.payload && typeof args?.payload === "object" ? (args.payload as Record<string, unknown>) : undefined;
		if (!payload || typeof payload.model !== "string") return undefined;
		const context = ctx as HookContext | undefined;
		const matches = context?.modelRegistry?.getAvailable?.()?.filter((entry) => entry.id === payload.model || entry.fullId === payload.model);
		const selected = context?.model ?? (matches?.length === 1 ? matches[0] : undefined);
		const model = selected ? toModelInfo(selected) : undefined;
		if (!model || model.provider !== "openrouter" || (payload.model !== model.id && payload.model !== model.fullId)) return undefined;
		if (!child && automaticRoute !== model.fullId) return undefined;
		if (isProvenFreeRoute(model) || (model.cost?.input === 0 && model.cost?.output === 0 && !isAuthorizedExpensiveModel(model.fullId, cfg))) return capFreeRequest(payload, model);
		if (!cfg.enabled || !cfg.openRouterMaxPrice) return undefined;
		const classification = classifyModelEconomy(model.fullId, model, cfg);
		if (classification.authorized) return undefined;
		// Affordable includes price-unproven routes under the relaxed economy.
		// Still pin provider.max_price to the absurd-rate caps so OpenRouter
		// cannot charge runaway prices on an unpriced metered route.
		if (classification.verdict !== "affordable") return undefined;
		const provider = payload.provider && typeof payload.provider === "object" ? { ...(payload.provider as Record<string, unknown>) } : {};
		const existing = provider.max_price && typeof provider.max_price === "object" ? (provider.max_price as Record<string, unknown>) : {};
        const qualified = operationalEconomyQualification(model,cfg);
        const inputCap = qualified?.maxPerMillion ?? cfg.maxInputPerMillion;
        const outputCap = qualified?.maxPerMillion ?? cfg.maxOutputPerMillion;
		const existingPrompt = Number(existing.prompt);
		const existingCompletion = Number(existing.completion);
		const prompt = Number.isFinite(existingPrompt) && existing.prompt !== undefined ? Math.min(existingPrompt, inputCap) : inputCap;
		const completion = Number.isFinite(existingCompletion) && existing.completion !== undefined ? Math.min(existingCompletion, outputCap) : outputCap;
		provider.max_price = { ...existing, prompt, completion };
		payload.provider = provider;
		return payload;
	});
}
