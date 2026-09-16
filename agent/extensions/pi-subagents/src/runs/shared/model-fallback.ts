import { getSupportedThinkingLevels, splitKnownThinkingSuffix, type ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";
import { filterFallbackCandidates, findModelExclusion, parseModelKey, recordModelFailure } from "./model-exclusions.ts";
import { checkModelScope, type ModelScopeCheckRule, type ModelScopeViolation, type ModelSource } from "./model-scope.ts";
import { redactSecretValues } from "./permissions.ts";
import {
	classifyModelEconomy,
	economyAffordableAlternatives,
	formatEconomyBlockedMessage,
	formatEconomyConfiguredWarning,
	formatEconomyNoRouteMessage,
	formatEconomyUnknownWarning,
	loadModelEconomyConfig,
} from "./model-economy.ts";
import { isProvenFreeRoute, catalogRouteCapabilities, readFreeEvidence } from "./free-route-evidence.ts";
import { taskQuality } from "./model-quality.ts";
import { isAutonomousMeteredEligible } from "./model-economy.ts";
import { selectAffordableModel } from "./model-selection.ts";
import { evaluateQuotaHealth, type QuotaEvent } from "./quota-health.ts";
import { readJournalQuotaEvents } from "./quota-journal.ts";
import { evaluateRoute, readHealth } from "./provider-health.ts";
import { modelIdentity } from "./model-quality.ts";
import { inferPreferenceRole, loadLlmPreferences, normalizeThinking, preferenceEntriesFor, providerOptionsToRouting } from "./llm-preferences.ts";

export type { AvailableModelInfo };

const economyWarnedRoutes = new Set<string>();

/** Best-effort selection telemetry. Failures here never affect selection. */
function noteHealth(kind: string, data: Record<string, unknown>): void {
	try { (globalThis as any)[Symbol.for("yunus-pi.health.v1")]?.(kind, data); } catch { /* telemetry is optional */ }
}

function taskRouteConstraints(task = ""): { fixed: boolean; freeOnly: boolean } {
 const text=task.slice(0,32768).replace(/```[\s\S]*?```/g," ").replace(/^\s*>.*$/gm," ");
 return {
  fixed:/\b(?:only use|use only|stick to|stay on)\b(?!\s+(?:the\s+)?free\b)|\b(?:same|current|this)\s+(?:model|provider)\s+only\b|\b(?:no|disable|do not|don't|never)\s+(?:(?:allow|enable)\s+)?(?:(?:automatic|model|provider)\s+)*fallbacks?\b|\b(?:do not|don't|never)\s+(?:switch|change)\s+(?:the\s+)?(?:provider|model)\b/i.test(text),
  freeOnly:/\bfree[- ]only\b|\b(?:only use|use only)\s+(?:the\s+)?free\b|\b(?:no|never use|do not use|don't use)\s+paid\b/i.test(text),
 };
}

/** Forget previously deduplicated economy warnings (fresh subagent run). */
/**
 * Live quota-health source (optional): when set, providers the quota-health
 * policy marks "exhausted" are dropped from automatic economy selection.
 * Unset (tests, fixtures) = previous behavior, byte for byte.
 */
let quotaEventReader: (() => QuotaEvent[]) | undefined;
export function setQuotaEventReader(reader: (() => QuotaEvent[]) | undefined): void {
	quotaEventReader = reader;
}

// Live wiring: consult the request journal tail. The mapper only classifies
// "exhausted" from explicit quota markers (never free-text), so absent quota
// events mean the exhausted list is empty and behavior is unchanged.
setQuotaEventReader(() => readJournalQuotaEvents());

function exhaustedProvidersOf(availableModels: AvailableModelInfo[] | undefined): string[] | undefined {
	if (!quotaEventReader || !availableModels?.length) return undefined;
	try {
		const events = quotaEventReader();
		if (!Array.isArray(events) || events.length === 0) return undefined;
		const providers = [...new Set(availableModels.map((entry) => entry.fullId.split("/")[0]).filter(Boolean))];
		return evaluateQuotaHealth(events, providers, Date.now())
			.filter((health) => health.state === "exhausted")
			.map((health) => health.provider);
	} catch {
		return undefined;
	}
}

export function clearEconomyWarnings(): void {
	economyWarnedRoutes.clear();
}

function warnOnceEconomy(key: string, kind: string, message: string): void {
	const marker = `${key}::${kind}`;
	if (economyWarnedRoutes.has(marker)) return;
	economyWarnedRoutes.add(marker);
	console.warn(message);
}

function registryHasPricing(availableModels: AvailableModelInfo[] | undefined): boolean {
	return Boolean(availableModels?.some((entry) => entry.cost !== undefined));
}

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	return splitKnownThinkingSuffix(model);
}

export function formatSubagentModelVerificationError(expectedModel: string, observedModel: string, availableModels: AvailableModelInfo[] | undefined): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const expectedBase = splitThinkingSuffix(expectedModel).baseModel;
	const observedBase = splitThinkingSuffix(observedModel).baseModel;
	if (expectedBase === observedBase) return undefined;
	const expectedEntry = availableModels.find((entry) => entry.fullId === expectedBase);
	if (expectedEntry) {
		if (expectedEntry.id === observedBase) return undefined;
		const expectedIdLeaf = expectedEntry.id.slice(expectedEntry.id.lastIndexOf("/") + 1);
		const expectedFullIdLeaf = expectedEntry.fullId.slice(expectedEntry.fullId.lastIndexOf("/") + 1);
		if (expectedIdLeaf === observedBase || expectedFullIdLeaf === observedBase) return undefined;
	}
	return `model_verification_failed: child reported a different model than the launch candidate. Expected '${expectedModel}' but observed '${observedModel}'.`;
}

/** Sentinel model value requesting that a subagent inherit the parent session's model. */
export const INHERIT_MODEL = "inherit";

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
	provider: string;
	id: string;
}

export function normalizeParentModel(model: unknown): ParentModel | undefined {
	if (!model || typeof model !== "object") return undefined;
	const candidate = model as { provider?: unknown; id?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
	if (!candidate.provider || !candidate.id) return undefined;
	return { provider: candidate.provider, id: candidate.id };
}

/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators.
 */
export function normalizeModelSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/[._]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
	const yyyy = Number(year);
	const mm = Number(month);
	const dd = Number(day);
	return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Drop a trailing date stamp (`-20251001` or `-2025-10-01`) so dated and undated ids match. */
function stripTrailingDateStamp(segment: string): string {
	const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
	if (dashed && isPlausibleDateStamp(dashed[2]!, dashed[3]!, dashed[4]!)) return dashed[1]!;
	const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
	if (compact && isPlausibleDateStamp(compact[2]!, compact[3]!, compact[4]!)) return compact[1]!;
	return segment;
}

function isRegisteredProvider(provider: string, availableModels: AvailableModelInfo[]): boolean {
	const normalized = normalizeModelSegment(provider);
	return availableModels.some((entry) => normalizeModelSegment(entry.provider) === normalized);
}

/**
 * Split `provider/id` only when the first path segment is a registered provider.
 * Hugging Face-style `owner/name` ids therefore stay intact unless `owner` is
 * itself a provider in the active registry. `:` and `.` keep the same rule.
 */
function splitQualifiedModelQuery(
	baseModel: string,
	availableModels: AvailableModelInfo[],
): { queryProvider?: string; queryIdRaw: string } {
	const slashIdx = baseModel.indexOf("/");
	if (slashIdx !== -1) {
		const providerPart = baseModel.slice(0, slashIdx);
		if (isRegisteredProvider(providerPart, availableModels)) {
			return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(slashIdx + 1) };
		}
		return { queryIdRaw: baseModel };
	}
	const providerSeparators = [":", "."];
	for (const separator of providerSeparators) {
		const separatorIdx = baseModel.indexOf(separator);
		if (separatorIdx <= 0) continue;
		const providerPart = baseModel.slice(0, separatorIdx);
		if (!isRegisteredProvider(providerPart, availableModels)) continue;
		return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(separatorIdx + 1) };
	}
	return { queryIdRaw: baseModel };
}

function resolveExactIdMatches(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return preferredMatch.fullId;
	}
	if (exactMatches.length === 1) return exactMatches[0]!.fullId;
	return undefined;
}

function resolveBaseModelCandidate(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const exact = availableModels.find((entry) => entry.fullId === baseModel);
	if (exact) return exact.fullId;

	const { queryProvider } = splitQualifiedModelQuery(baseModel, availableModels);
	if (queryProvider === undefined) {
		const exactId = resolveExactIdMatches(baseModel, availableModels, preferredProvider);
		if (exactId) return exactId;
	}

	return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A slash is a provider
 * prefix only when that prefix is a registered provider; otherwise the whole
 * string is the model id (Hugging Face `owner/name`). A qualified provider
 * query only matches within the named provider — this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates).
 */
export function fuzzyResolveModel(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
	const queryId = normalizeModelSegment(queryIdRaw);
	const queryIdNoDate = stripTrailingDateStamp(queryId);

	const candidates = availableModels.filter((entry) => {
		const entryId = normalizeModelSegment(entry.id);
		if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
		if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider) return false;
		return true;
	});
	if (candidates.length === 0) return undefined;
	if (preferredProvider) {
		const preferredProviderNorm = normalizeModelSegment(preferredProvider);
		const preferred = candidates.filter((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
		if (preferred.length) return preferred.length === 1 ? preferred[0]!.fullId : undefined;
	}
	if (candidates.length === 1) return candidates[0]!.fullId;
	return undefined;
}

/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query.
 */
export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (!availableModels || availableModels.length === 0) return model;

	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	if (!thinkingSuffix) return model;
	const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
	if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
	return model;
}

function resolveSubagentModelCandidate(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return model;
	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const resolvedBase = thinkingSuffix ? resolveBaseModelCandidate(baseModel, availableModels, preferredProvider) : undefined;
	return resolvedBase ? `${resolvedBase}${thinkingSuffix}` : undefined;
}

export interface LlmPreferenceRequirements {
	minContextWindow?: number;
	minOutputTokens?: number;
	reasoning?: boolean;
	inputModalities?: string[];
	toolCalling?: boolean;
}

export interface LlmPreferenceRoute {
	/** Canonical `provider/id` validated against the live registry. */
	route: string;
	/** Concrete thinking level when explicitly configured and supported. */
	thinking?: string;
	/** True when the existing dynamic-thinking logic should decide. */
	dynamicThinking: boolean;
	/** Translated `compat.openRouterRouting` when the entry pins a backend. */
	providerRouting?: Record<string, unknown>;
	explanation: string[];
}

export interface LlmPreferenceOptions {
	requirements?: LlmPreferenceRequirements;
	/** Restrict the chain to proven-free routes (explicit free-only tasks). */
	freeOnly?: boolean;
}

/**
 * Ordered viable preference routes for a role. Each entry is validated
 * against the live registry (fuzzy resolution), cached exclusions, shared
 * provider-health cooldowns and capability requirements; unusable entries
 * are skipped and the chain continues. Explicit user preferences bypass
 * economy price caps but never health, exclusion or capability gates.
 * Returns [] when the file is missing, malformed or has no viable entry,
 * in which case callers use the existing autonomous selection.
 */
export function resolveLlmPreferenceChain(
	role: string,
	availableModels: AvailableModelInfo[] | undefined,
	options?: LlmPreferenceOptions,
): LlmPreferenceRoute[] {
	const loaded = loadLlmPreferences();
	if (!loaded.ok || !loaded.config || !availableModels || availableModels.length === 0) return [];
	const entries = preferenceEntriesFor(role, loaded.config);
	if (!entries.length) return [];
	const out: LlmPreferenceRoute[] = [];
	const seen = new Set<string>();
	const now = Date.now();
	let health: ReturnType<typeof readHealth> | undefined;
	for (const entry of entries) {
		const query = entry.provider && entry.model && !entry.model.includes("/") ? `${entry.provider}/${entry.model}` : (entry.model ?? "");
		if (!query) continue;
		const suffix = splitThinkingSuffix(query);
		const resolved = resolveSubagentModelCandidate(suffix.baseModel, availableModels, entry.provider);
		if (!resolved) {
			warnOnceEconomy(query, "preference-unresolved", `[pi-subagents] llm_preferences (${role}): no live registry match for ${JSON.stringify(query)}; continuing chain`);
			noteHealth("model.skip", { route: query, outcome: "unresolved" });
			continue;
		}
		const base = splitThinkingSuffix(resolved).baseModel;
		const identity = base.toLowerCase();
		if (seen.has(identity)) continue;
		const exclusion = findModelExclusion(base);
		if (exclusion) {
			warnOnceEconomy(base, "preference-excluded", `[pi-subagents] llm_preferences (${role}): skipping ${base} (excluded until ${new Date(exclusion.expiresAt).toISOString()}: ${exclusion.reason ?? "no reason"}); continuing chain`);
			noteHealth("model.skip", { route: base, outcome: "excluded" });
			continue;
		}
		const info = availableModels.find((entry) => entry.fullId === base);
		if (!info) continue;
		if (!health) health = readHealth();
		try {
			const decision = evaluateRoute({ provider: info.provider, model: info.id, now }, health);
			if (!decision.allowed) {
				warnOnceEconomy(base, "preference-cooling", `[pi-subagents] llm_preferences (${role}): skipping ${base} (route cooling until ${new Date(decision.cooldownUntil).toISOString()}); continuing chain`);
				noteHealth("model.skip", { route: base, outcome: "cooling" });
				continue;
			}
		} catch { continue; }
		const req = options?.requirements;
		if (req?.minContextWindow !== undefined && !(typeof info.contextWindow === "number" && info.contextWindow >= req.minContextWindow)) continue;
		if (req?.minOutputTokens !== undefined && !(typeof info.maxTokens === "number" && info.maxTokens >= req.minOutputTokens)) continue;
		if (req?.reasoning === true && info.reasoning !== true) continue;
		if (req?.inputModalities?.some((input) => !info.input?.includes(input))) continue;
		if (req?.toolCalling && catalogRouteCapabilities(info)?.toolCalling !== true) continue;
		if (options?.freeOnly && !isProvenFreeRoute(info)) continue;
		const wanted = suffix.thinkingSuffix ? suffix.thinkingSuffix.slice(1) : entry.thinking;
		const norm = normalizeThinking(wanted);
		const thinking = !norm.dynamic && norm.thinking && getSupportedThinkingLevels(info).includes(norm.thinking) ? norm.thinking : undefined;
		const translated = providerOptionsToRouting(entry.provider_options, info.provider);
		seen.add(identity);
		out.push({
			route: base,
			...(thinking ? { thinking } : {}),
			dynamicThinking: !thinking,
			...(translated.routing ? { providerRouting: translated.routing } : {}),
			explanation: [`explicit llm_preferences (${role})`, ...(thinking ? [`thinking ${thinking}`] : ["dynamic thinking"]), ...(translated.routing ? ["openrouter backend routing"] : [])],
		});
	}
	return out;
}

/** First viable preference for a role, or undefined for autonomous fallback. */
export function selectLlmPreferredModel(
	role: string,
	availableModels: AvailableModelInfo[] | undefined,
	options?: LlmPreferenceOptions,
): LlmPreferenceRoute | undefined {
	return resolveLlmPreferenceChain(role, availableModels, options)[0];
}

/** Distribute `count` slots across the viable chain: distinct model
 * identities first (council/multi-model diversity), then cycle to reuse
 * suitable entries. Callers fill any remaining gap with autonomous picks. */
export function distributeLlmPreferredModels(
	role: string,
	count: number,
	availableModels: AvailableModelInfo[] | undefined,
	options?: LlmPreferenceOptions & { diverse?: boolean },
): LlmPreferenceRoute[] {
	const chain = resolveLlmPreferenceChain(role, availableModels, options);
	if (!chain.length || !Number.isSafeInteger(count) || count <= 0) return [];
	const ordered = options?.diverse === false ? chain : [
		...chain.filter((item, index, self) => self.findIndex((other) => modelIdentity(other.route) === modelIdentity(item.route)) === index),
		...chain.filter((item, index, self) => self.findIndex((other) => modelIdentity(other.route) === modelIdentity(item.route)) !== index),
	];
	return Array.from({ length: Math.min(count, 64) }, (_, i) => ordered[i % ordered.length]!);
}

/** Route with its configured thinking suffix, or the plain route when the
 * existing dynamic-thinking logic should decide. */
export function withLlmThinkingSuffix(route: LlmPreferenceRoute): string {
	return route.thinking ? `${route.route}:${route.thinking}` : route.route;
}

function suggestAlternateProviderModel(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
	if (queryProvider === undefined) return undefined;
	const suggestion = resolveBaseModelCandidate(queryIdRaw, availableModels);
	if (!suggestion) return undefined;
	const matched = availableModels.find((entry) => entry.fullId === suggestion);
	if (!matched || normalizeModelSegment(matched.provider) === queryProvider) return undefined;
	return `${suggestion}${thinkingSuffix}`;
}

function resolveRequiredSubagentModelCandidate(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string {
	const resolved = resolveSubagentModelCandidate(model, availableModels, preferredProvider);
	if (resolved) return resolved;
	const suggestion = suggestAlternateProviderModel(model, availableModels);
	throw new Error(
		`Unknown subagent model '${model}' in the active Pi model registry.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`,
	);
}

export interface ResolveSubagentModelOverrideOptions {
 /** Task-aware quality admission; omitted only by display/preflight callers. */
 task?: string;
	/** When set with `enforce: true`, out-of-scope models are rejected. */
	scope?: ModelScopeCheckRule | ModelScopeCheckRule[];
	/** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
	source?: ModelSource;
	/** Called for warn-severity violations instead of `console.warn`. */
	onWarn?: (violation: ModelScopeViolation) => void;
	/** Session id enabling the preferred/free session mixer (rotation +
	 * seeded variety). Omitted callers keep deterministic legacy order. */
	sessionId?: string;
}

function defaultScopeWarn(violation: ModelScopeViolation): void {
	console.warn(`[pi-subagents] ${violation.message}`);
}

function configuredScopes(scope: ModelScopeCheckRule | ModelScopeCheckRule[] | undefined): ModelScopeCheckRule[] {
	return scope ? (Array.isArray(scope) ? scope : [scope]) : [];
}

function throwForUnresolvedEnforcedInheritScope(scope: ModelScopeCheckRule | ModelScopeCheckRule[] | undefined, includeMixed = false): void {
	const unresolvedInheritScope = configuredScopes(scope)
		.find((entry) => entry.enforce === true && (includeMixed ? entry.allow?.includes(INHERIT_MODEL) : entry.allow?.length === 1 && entry.allow[0] === INHERIT_MODEL));
	if (!unresolvedInheritScope) return;
	const origin = unresolvedInheritScope.origin ?? "modelScope";
	throw new Error(`Cannot enforce subagent model scope (${origin}): 'inherit' requires a current parent session model.`);
}

function enforceModelScopes(
	model: string,
	scope: ModelScopeCheckRule | ModelScopeCheckRule[] | undefined,
	source: ModelSource,
	onWarn: ((violation: ModelScopeViolation) => void) | undefined,
): void {
	const violations = configuredScopes(scope)
		.map((entry) => checkModelScope(model, entry, source))
		.filter((violation): violation is ModelScopeViolation => violation !== undefined);
	const error = violations.find((violation) => violation.severity === "error");
	if (error) throw new Error(error.message);
	for (const violation of violations) (onWarn ?? defaultScopeWarn)(violation);
}

function throwForExplicitModelExclusion(model: string): void {
	const exclusion = findModelExclusion(model);
	if (!exclusion) return;
	const reason = redactSecretValues((exclusion.reason ?? "runtime-failure").replace(/[\u0000-\u001f\u007f]+/g, " ")).slice(0, 240);
	const expiry = Number.isFinite(exclusion.expiresAt) ? `; expires: ${new Date(exclusion.expiresAt).toISOString()}` : "";
	throw new Error(`Requested subagent model '${model}' is excluded and cannot be replaced by a fallback (reason: ${reason}${expiry}).`);
}

/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child must inherit the parent session's *in-memory* model
 * (`provider/id`) instead of being left to resolve its own model. Without an
 * explicit `provider/id`, the child falls back to the global
 * `~/.pi/agent/settings.json` default, which is shared across every open PI
 * session — so a different session that last changed its model in the TUI would
 * silently contaminate this session's subagents (see issue #266). Passing an
 * explicit `provider/id` keeps each session's children isolated to that
 * session's model.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one,
 * unless strict scope enforcement makes inherited violations hard errors.
 */
export interface MixCandidate {
	route: string;
	preferred: boolean;
	free: boolean;
}

const mixSession: { id: string | undefined; uses: Map<string, number>; draws: number } = { id: undefined, uses: new Map(), draws: 0 };

/** Deterministic per-session stream (FNV-1a + mulberry32): varied across
 * sessions, reproducible within one for tests and debugging. */
function mixRandom(): number {
	let h = (2166136261 ^ mixSession.draws++) | 0;
	const s = mixSession.id ?? "";
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
	h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Session-aware preferred/free mixer. Live sessions (sessionId set) rotate
 * by frequency, bias critical tasks to preferred routes, respect health via
 * the already-gated pool, and add seeded variety. Without a sessionId the
 * scoring collapses to deterministic legacy order (preferred chain first,
 * then the affordable pick), so offline suites observe zero behavior change. */
export function mixSubagentModel(pool: MixCandidate[], task = "", sessionId?: string): MixCandidate | undefined {
	if (!pool.length) return undefined;
	if (mixSession.id !== sessionId) { mixSession.id = sessionId; mixSession.uses.clear(); mixSession.draws = 0; }
	const live = sessionId !== undefined;
	const critical = taskQuality(task).level === "critical";
	// Critical work stays on explicit preferences whenever any survived
	// gating (the pool is already freeOnly-filtered when constrained, so
	// this never violates an explicit free-only request).
	const ranked = live && critical && pool.some((c) => c.preferred) ? pool.filter((c) => c.preferred) : pool;
	let best: MixCandidate | undefined;
	let bestScore = -Infinity;
	for (const c of ranked) {
		const uses = live ? (mixSession.uses.get(c.route) ?? 0) : 0;
		const score = live
			? (c.preferred ? 4 : 0) + (c.free ? 3 : 0) + (critical && c.preferred ? 4 : 0) - 2.5 * uses + mixRandom()
			: (c.preferred ? 10 : 0);
		if (score > bestScore) { bestScore = score; best = c; }
	}
	if (best && live) {
		mixSession.uses.set(best.route, (mixSession.uses.get(best.route) ?? 0) + 1);
		noteHealth("model.mix", { route: best.route, decision: best.preferred && best.free ? "preferred-free" : best.preferred ? "preferred" : best.free ? "free" : "affordable" });
	}
	return best;
}

/** Gather the viable preferred chain plus up to 3 affordable candidates and
 * mix one route. Returns undefined when the pool is empty so callers keep
 * their existing fallback behavior. */
export function selectMixedSubagentModel(
	availableModels: AvailableModelInfo[] | undefined,
	cfg: ReturnType<typeof loadModelEconomyConfig>,
	task: string,
	opts: { freeOnly?: boolean; sessionId?: string; preferredModel?: string; exhaustedProviders?: string[] },
): string | undefined {
	const chain = resolveLlmPreferenceChain(inferPreferenceRole(task), availableModels, { freeOnly: opts.freeOnly });
	const seen = new Set<string>();
	const pool: MixCandidate[] = [];
	for (const c of chain) {
		const key = c.route.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const info = availableModels?.find((m) => m.fullId === c.route);
		pool.push({ route: withLlmThinkingSuffix(c), preferred: true, free: info ? isProvenFreeRoute(info) : false });
	}
	const exclude = pool.map((p) => splitThinkingSuffix(p.route).baseModel);
	for (let i = 0; i < 3; i++) {
		const pick = selectAffordableModel(availableModels, cfg, { task, freeOnly: opts.freeOnly, preferredModel: opts.preferredModel, exclude, exhaustedProviders: opts.exhaustedProviders });
		if (!pick) break;
		exclude.push(splitThinkingSuffix(pick.model).baseModel);
		const key = pick.model.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const info = availableModels?.find((m) => m.fullId === splitThinkingSuffix(pick.model).baseModel);
		pool.push({ route: pick.model, preferred: false, free: info ? isProvenFreeRoute(info) : false });
	}
	return mixSubagentModel(pool, task, opts.sessionId)?.route;
}

export function resolveSubagentModelOverride(
	requestedModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
	if (!parentModel) throwForUnresolvedEnforcedInheritScope(options?.scope, explicit === undefined || options?.source === "inherited");
	let resolved: string | undefined;
	let resolvedFromRegistry = explicit === undefined;
	if (explicit === undefined) {
		resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	} else {
		const candidate = resolveSubagentModelCandidate(explicit, availableModels, preferredProvider);
		if (options?.source === "explicit") {
			resolved = candidate ?? resolveRequiredSubagentModelCandidate(explicit, availableModels, preferredProvider);
			throwForExplicitModelExclusion(resolved);
			resolvedFromRegistry = true;
		} else if (candidate) {
			resolved = candidate;
			resolvedFromRegistry = true;
		} else {
			resolved = explicit;
		}
	}
	if (resolved && options?.scope && resolvedFromRegistry) {
		const source: ModelSource = explicit === undefined ? "inherited" : (options.source ?? "inherited");
		enforceModelScopes(resolved, options.scope, source, options.onWarn);
	}
	if (resolved) {
		const cfg = loadModelEconomyConfig();
		if (cfg.enabled && registryHasPricing(availableModels)) {
			const { info } = economyRouteInfo(resolved, availableModels);
			if (info) {
				const classification = classifyModelEconomy(splitThinkingSuffix(resolved).baseModel, info, cfg);
				if (explicit === undefined && options?.task) {
     const constraints=taskRouteConstraints(options.task);
     if (!constraints.fixed) {
      const mixed = selectMixedSubagentModel(availableModels, cfg, options.task, { freeOnly: constraints.freeOnly, sessionId: options.sessionId, preferredModel: resolved, exhaustedProviders: exhaustedProvidersOf(availableModels) });
      if (mixed) { enforceModelScopes(mixed, options?.scope, "inherited", options?.onWarn); return mixed; }
      const preferred = selectLlmPreferredModel(inferPreferenceRole(options.task), availableModels, { freeOnly: constraints.freeOnly });
      if (preferred) { const preferredRoute = withLlmThinkingSuffix(preferred); enforceModelScopes(preferredRoute, options?.scope, "inherited", options?.onWarn); return preferredRoute; }
     }
     const pick = constraints.fixed ? undefined : selectAffordableModel(availableModels,cfg,{task:options.task,freeOnly:constraints.freeOnly,preferredModel:resolved,exhaustedProviders:exhaustedProvidersOf(availableModels)});
     if (pick) { enforceModelScopes(pick.model,options?.scope,"inherited",options?.onWarn); return pick.model; }
     if (["expensive","zero-placeholder"].includes(classification.verdict) || constraints.freeOnly && !isProvenFreeRoute(info)) throw new Error(`${formatEconomyNoRouteMessage(resolved,cfg)} No affordable route passed the task quality/route constraints; keep this work in the parent or supply verified benchmark evidence.`);
				} else if (explicit === undefined && (classification.verdict === "expensive" || classification.verdict === "zero-placeholder")) {
					const preferredExpensive = selectLlmPreferredModel(inferPreferenceRole(options?.task), availableModels, {});
					if (preferredExpensive) { const preferredRoute = withLlmThinkingSuffix(preferredExpensive); enforceModelScopes(preferredRoute, options?.scope, "inherited", options?.onWarn); return preferredRoute; }
					const pick = selectAffordableModel(availableModels, cfg, { preferredModel: resolved, exclude: [resolved], exhaustedProviders: exhaustedProvidersOf(availableModels) });
					if (!pick) throw new Error(formatEconomyNoRouteMessage(resolved, cfg));
					enforceModelScopes(pick.model, options?.scope, "inherited", options?.onWarn);
					return pick.model;
				}
				if ((options?.source ?? "inherited") === "explicit" && explicit !== undefined && (classification.verdict === "expensive" || classification.verdict === "zero-placeholder")) {
					throw new Error(formatEconomyBlockedMessage(resolved, classification, cfg, economyAffordableAlternatives(availableModels, cfg, resolved)));
				}
				if (classification.verdict === "unknown-price" && explicit === undefined) warnOnceEconomy(resolved, "unknown", formatEconomyUnknownWarning(resolved, cfg));
			}
		}
	}
	return resolved;
}

export function resolveEffectiveSubagentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const source = options?.source ?? (explicitModel !== undefined ? "explicit" : "inherited");
	const resolved = resolveSubagentModelOverride(
		explicitModel ?? agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source },
	);
	if (resolved || explicitModel === undefined) return resolved;
	return resolveSubagentModelOverride(
		agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: options?.source ?? "inherited" },
	);
}

export type ModelOrigin = ModelSource | "configured";

export interface BuildModelCandidatesOptions {
	/** Legacy workflow authorities remain single-route unless explicitly expanded. */
	allowAutomaticAlternatives?: boolean;
	/** Fallback models warn by default and throw when strict scope enforcement is enabled. */
	scope?: ModelScopeCheckRule | ModelScopeCheckRule[];
	onWarn?: (violation: ModelScopeViolation) => void;
	/** The primary model came from the running parent session, not configuration. */
	primaryModelFromParent?: boolean;
	/** How the primary model was selected. Explicit stays strict and does not rotate to fallbacks. */
	origin?: ModelOrigin;
	/** Current task constraints restrict automatic additions before any process launch. */
	task?: string;
}

const ZERO_USABLE_MODEL_CANDIDATES_ERROR =
	"No usable subagent models remain after registry, scope, and cached-exclusion filtering.";

export function resolveModelOrigin(input: {
	explicitModel?: string | boolean;
	agentModel?: string | boolean;
	parentModel?: ParentModel;
	fromParent?: boolean;
	storedOrigin?: ModelOrigin;
}): ModelOrigin {
	if (input.storedOrigin) return input.storedOrigin;
	if (input.fromParent) return "inherited";
	if (inheritsParentModel(input.explicitModel, input.agentModel, input.parentModel)) return "inherited";
	const trimmed = typeof input.explicitModel === "string" ? input.explicitModel.trim() : "";
	return trimmed && trimmed !== INHERIT_MODEL ? "explicit" : "configured";
}

export function inheritsParentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
): boolean {
	const requestedModel = explicitModel ?? agentModel;
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	return Boolean(parentModel && (!trimmed || trimmed === INHERIT_MODEL));
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: BuildModelCandidatesOptions,
): string[] {
	if (!primaryModel) throwForUnresolvedEnforcedInheritScope(options?.scope, true);
	const origin = options?.origin ?? (options?.primaryModelFromParent ? "inherited" : "configured");
	const scopes = configuredScopes(options?.scope);
	const warnCachedExclusion = (candidate: string, exclusion: NonNullable<ReturnType<typeof findModelExclusion>>) => {
		const reason = redactSecretValues((exclusion.reason ?? "runtime-failure").replace(/[\u0000-\u001f\u007f]+/g, " ")).slice(0, 240);
		console.warn(`[pi-subagents] Skipping model '${candidate}' due to a cached exclusion (reason: ${reason}; expires: ${new Date(exclusion.expiresAt).toISOString()}).`);
	};
	if (origin === "explicit" && primaryModel) {
		const normalized = resolveRequiredSubagentModelCandidate(primaryModel.trim(), availableModels, preferredProvider);
		throwForExplicitModelExclusion(normalized);
		enforceModelScopes(normalized, scopes, "explicit", options?.onWarn);
		primaryModel = normalized;
	}
	const seen = new Set<string>();
	const candidates: string[] = [];
	const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
	let skippedPrimary: string | undefined;
	for (let index = 0; index < rawCandidates.length; index++) {
		const raw = rawCandidates[index];
		if (!raw) continue;
		const model = raw.trim();
		const normalized = index === 0 && (origin === "inherited" || origin === "explicit" || options?.primaryModelFromParent)
			? model
			: resolveSubagentModelCandidate(model, availableModels, preferredProvider);
		if (!normalized) {
			if (index === 0) skippedPrimary = model;
			else console.warn(`[pi-subagents] Skipping fallback model '${model}' because it is unavailable in this environment.`);
			continue;
		}
		if (seen.has(normalized)) continue;
		if (index > 0 || scopes.some((scope) => scope.enforce === true && scope.strict === true)) {
			enforceModelScopes(normalized, scopes, "inherited", options?.onWarn);
		}
		seen.add(normalized);
		candidates.push(normalized);
	}
	const resolved = filterFallbackCandidates(candidates, { onExcluded: warnCachedExclusion });
	if (resolved.length === 0) {
		if (skippedPrimary) resolveRequiredSubagentModelCandidate(skippedPrimary, availableModels, preferredProvider);
		if (candidates.length > 0) throw new Error(ZERO_USABLE_MODEL_CANDIDATES_ERROR);
		return resolved;
	}
	if (skippedPrimary) {
		console.warn(`[pi-subagents] Skipping primary model '${skippedPrimary}' because it is unavailable in this environment.`);
	}
	const economical = applyCandidateEconomy(resolved, availableModels, origin, options?.task);
	for (const route of economical) if (!resolved.includes(route)) enforceModelScopes(route, scopes, "inherited", options?.onWarn);
	// Inherited automatic workers may continue on a small, pre-admitted set.
	// Explicit/configured model choices and caller fallback lists remain exact.
	const pinsRoute=/\b(?:only use|use only|stick to|stay on)\b|\b(?:same|current|this)\s+(?:model|provider)\s+only\b|\b(?:no|disable|do not|don't|never)\s+(?:(?:allow|enable)\s+)?(?:(?:automatic|model|provider)\s+)*fallbacks?\b|\b(?:do not|don't|never)\s+(?:switch|change)\s+(?:the\s+)?(?:provider|model)\b/i.test(options?.task??"");
	if(options?.allowAutomaticAlternatives!==false&&origin==="inherited"&&!pinsRoute&&!fallbackModels?.length&&process.env.PI_AUTONOMOUS_MODEL_FALLBACK!=="off") {
		for (const pref of resolveLlmPreferenceChain(inferPreferenceRole(options?.task), availableModels, {})) {
			if (economical.length >= 3) break;
			const prefRoute = withLlmThinkingSuffix(pref);
			if (economical.includes(prefRoute) || economical.some(e => splitKnownThinkingSuffix(e).baseModel === pref.route)) continue;
			try { enforceModelScopes(prefRoute, scopes, "inherited", options?.onWarn); } catch { continue; }
			economical.push(prefRoute);
		}
		const cfg=loadModelEconomyConfig();
		const first=availableModels?.find(model=>model.fullId===splitKnownThinkingSuffix(economical[0]).baseModel);
		if(cfg.enabled&&first&&Number.isSafeInteger(first.contextWindow)&&first.contextWindow!>0&&Number.isSafeInteger(first.maxTokens)&&first.maxTokens!>0) {
			const evidence=readFreeEvidence();const freeOnly=isProvenFreeRoute(first,evidence);
			const pool=(availableModels??[]).filter(model=>Number.isSafeInteger(model.contextWindow)&&model.contextWindow!>=first.contextWindow!
				&&Number.isSafeInteger(model.maxTokens)&&model.maxTokens!>=first.maxTokens!
				&&(!first.reasoning||model.reasoning===true)&&(!first.input||first.input.every(input=>model.input?.includes(input)))
				&&catalogRouteCapabilities(model,evidence)?.toolCalling===true
				&&(isProvenFreeRoute(model,evidence)||!freeOnly&&isAutonomousMeteredEligible(model,cfg)));
			const excluded=[...economical];
			for(let attempts=0;attempts<8&&economical.length<3;attempts++) {
				const choice=selectAffordableModel(pool,cfg,{task:options?.task,preferredModel:first.fullId,exclude:excluded,exhaustedProviders:exhaustedProvidersOf(availableModels)});
				if(!choice)break;excluded.push(choice.model);
				try {enforceModelScopes(choice.model,scopes,"explicit",options?.onWarn);}catch {continue;}
				economical.push(choice.model);
			}
		}
	}
	return economical;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/usage\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection\s+(?:error|reset|closed|aborted)/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/stream ended without finish_reason/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b500\b/,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
	/internal server error/i,
	/cold.?start/i,
	/empty response/i,
	/no output/i,
	/model.*(?:load|fail|error)/i,
];

/**
 * Failures reported as `<tool> failed (exit N): ...` or `<tool> failed with
 * exit code N` come from a tool call inside the child's task, not from the
 * provider/model, however network-flavored their details read. Retrying a
 * different model cannot fix them and would rerun the whole task. Tool names
 * include namespaced forms like `mcp.server/write`.
 */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

function messageError(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = (message as { errorMessage?: unknown }).errorMessage;
	return typeof value === "string" ? value : undefined;
}

export function isRetryableModelFailureAttempt(input: { error: string | undefined; messages?: readonly unknown[]; toolCount?: number }): boolean {
	if (!isRetryableModelFailure(input.error)) return false;
	if ((input.toolCount ?? 0) > 0) return false;
	if (input.error === "Subagent produced no output (possible model cold-start or empty response)." || /^Subagent produced no output after terminal assistant stopReason "[^"]+"\.$/.test(input.error ?? "")) return true;
	if ((input.toolCount ?? 0) === 0 && (input.messages?.length ?? 0) === 0) return true;
	const error = input.error?.trim();
	return Boolean(error && input.messages?.some((message) => messageError(message)?.trim() === error));
}

export function recordRetryableModelFailure(model: string | undefined, error: string | undefined): void {
	if (!model || !isRetryableModelFailure(error)) return;
	const { provider, modelId } = parseModelKey(model);
	recordModelFailure({ modelId, reason: error, ...(provider ? { provider } : {}) });
}

/**
 * Context-overflow signals. These are deliberately NOT part of
 * {@link RETRYABLE_MODEL_FAILURE_PATTERNS}: an overflow means the input was too
 * large for the model's context window, so retrying the same input on another
 * model (or the same model again) cannot succeed. Callers should treat overflow
 * as a terminal, non-retryable failure and surface a clear "input too large"
 * error instead of burning fallback attempts on a guaranteed failure.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
	/context(?: length| window| limit)? (?:exceed|overflow|too long)/i,
	/maximum context length/i,
	/too many tokens/i,
	/token limit/i,
	/context_length_exceeded/i,
	/length_required/i,
	/maximum.*tokens/i,
	/prompt.*too long/i,
	/input.*too long/i,
	/exceeded.*context/i,
	/context.*overflow/i,
];

export function isContextOverflow(error: string | undefined): boolean {
	if (!error) return false;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}

// --- 2026-09-06 economy enforcement ----------------------------------------

function economyRouteInfo(route: string, availableModels: AvailableModelInfo[] | undefined) {
	const base = splitThinkingSuffix(route).baseModel;
	const info = availableModels?.find((entry) => entry.fullId === base);
	return { info, base };
}

/**
 * Filter/enrich a resolved candidate list against the economy policy.
 * Origin semantics (see BuildModelCandidatesOptions):
 *  - explicit: expensive/zero metered routes are a hard, actionable error.
 *  - inherited: an expensive/zero parent primary is replaced by the
 *    deterministic affordable selection (fail-closed when none exists);
 *    unknown-price parents are kept with a warning.
 *  - configured: the primary (human route) is honored with a warning when it
 *    exceeds the caps; unaffordable/unknown fallback members are dropped.
 * Economy filtering only engages when the registry actually carries price
 * metadata (cost-less fixtures keep their legacy behavior unchanged).
 */
function applyCandidateEconomy(
	candidates: string[],
	availableModels: AvailableModelInfo[] | undefined,
	origin: ModelOrigin,
 task?: string,
): string[] {
	const cfg = loadModelEconomyConfig();
	if (!cfg.enabled || !registryHasPricing(availableModels) || candidates.length === 0) return candidates;
 const constraints=taskRouteConstraints(task);
 if (origin === "inherited" && task) {
  const pick=constraints.fixed ? undefined : selectAffordableModel(availableModels,cfg,{task,freeOnly:constraints.freeOnly,preferredModel:candidates[0],exhaustedProviders:exhaustedProvidersOf(availableModels)});
  if (pick) candidates=[pick.model,...candidates.slice(1).filter(route=>route!==pick.model)];
  else if (constraints.freeOnly && !isProvenFreeRoute(economyRouteInfo(candidates[0],availableModels).info)) throw new Error("No eligible free route satisfies this task; keep the work in the parent. Paid assistance was not admitted.");
 }
	const kept: string[] = [];
	let primaryDropped = false;
	for (let index = 0; index < candidates.length; index++) {
		const route = candidates[index]!;
		const { info, base } = economyRouteInfo(route, availableModels);
		const isPrimary = index === 0;
  if (constraints.freeOnly && !isProvenFreeRoute(info)) {
   if (isPrimary) throw new Error("Free-only task refused a route without current free pricing evidence.");
   continue;
  }
		if (!info) {
			kept.push(route);
			continue;
		}
		const classification = classifyModelEconomy(base, info, cfg);
		const unaffordable = classification.verdict === "expensive" || classification.verdict === "zero-placeholder";
		if (origin === "explicit") {
			if (unaffordable) {
				throw new Error(formatEconomyBlockedMessage(base, classification, cfg, economyAffordableAlternatives(availableModels, cfg, base)));
			}
			if (classification.verdict === "unknown-price") warnOnceEconomy(base, "unknown", formatEconomyUnknownWarning(base, cfg));
			kept.push(route);
			continue;
		}
		if (isPrimary && origin === "inherited" && unaffordable) {
			primaryDropped = true;
			continue;
		}
		if (isPrimary && origin === "configured" && unaffordable) {
			warnOnceEconomy(base, "configured-expensive", formatEconomyConfiguredWarning(base, cfg));
		}
		if (!isPrimary && (unaffordable || classification.verdict === "unknown-price")) continue;
		if (classification.verdict === "unknown-price") warnOnceEconomy(base, "unknown", formatEconomyUnknownWarning(base, cfg));
		kept.push(route);
	}
	let result = kept;
	if (primaryDropped) {
		const pick = constraints.fixed ? undefined : selectAffordableModel(availableModels, cfg, { task, freeOnly:constraints.freeOnly, preferredModel: candidates[0]!, exclude: [candidates[0]!, ...kept], exhaustedProviders: exhaustedProvidersOf(availableModels) });
		if (!pick) throw new Error(`${formatEconomyNoRouteMessage(candidates[0]!, cfg)}${task ? " No route passed the task quality gate; keep this work in the parent or supply verified model evidence." : ""}`);
		result = [pick.model, ...kept.filter((route) => route !== pick.model)];
	}
	return constraints.fixed ? result.slice(0,1) : result;
}
