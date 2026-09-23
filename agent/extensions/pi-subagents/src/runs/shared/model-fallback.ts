import { sessionObservability } from '../../../../lib/session-observability.ts';
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { clampSupportedThinkingLevel, splitKnownThinkingSuffix, type ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { filterFallbackCandidates, findModelExclusion, parseModelKey, recordModelFailure } from "./model-exclusions.ts";
import { isLocalModelResolutionFailure } from "./local-model-failure.ts";
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
import { formatAffordableSelectionDiagnostics, selectAffordableModel } from "./model-selection.ts";
import { evaluateQuotaHealth, type QuotaEvent } from "./quota-health.ts";
import { readJournalQuotaEvents } from "./quota-journal.ts";
import { evaluateRoute, readHealth } from "./provider-health.ts";
import { modelIdentity } from "./model-quality.ts";
import { inferPreferenceRole, loadLlmPreferences, normalizeThinking, preferenceEntriesFor, providerOptionsToRouting, normalizePreferenceRole, readLlmPreferencesDocument, validateLlmPreferencesDocumentForWrite, SESSION_OBSERVER_DEFAULT, SESSION_OBSERVER_ROLE, type LlmModelEntry } from "./llm-preferences.ts";
import { modelRouteCandidateKey, normalizeModelRouteCandidate, routeOf, stableProviderRouting, type ModelRouteCandidate } from "../../shared/model-route.ts";
import { childRequirementsFromTask, type ChildRouteRequirements } from "./child-route-requirements.ts";
import { extractTaskIntent } from "./task-intent-model.ts";

/** Child-scoped route bounds for fallback selection, memoized per task text. */
const childBoundsCache = new Map<string, ChildRouteRequirements>();
function childFor(task: string | undefined): ChildRouteRequirements | undefined {
	if (!task) return undefined;
	// Every part of the brief can carry modality or output requirements.
	// Keep a bounded digest instead of collapsing equal-length middle edits.
	const key = createHash("sha256").update(task).digest("hex");
	const hit = childBoundsCache.get(key);
	if (hit) return hit;
	const bounds = childRequirementsFromTask(task);
	if (childBoundsCache.size >= 64) childBoundsCache.clear();
	childBoundsCache.set(key, bounds);
	return bounds;
}

export type { AvailableModelInfo };

const economyWarnedRoutes = new Set<string>();

/** Best-effort selection telemetry. Failures here never affect selection. */
function noteHealth(kind: string, data: Record<string, unknown>): void {
	try { sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.(kind, data); } catch { /* telemetry is optional */ }
}

function taskRouteConstraints(task = ""): { fixed: boolean; freeOnly: boolean } {
 // Segmented first: quoted/example spans ("the docs say 'use only free'")
 // are never routing directives.
 let text=task.slice(0,32768).replace(/```[\s\S]*?```/g," ").replace(/^\s*>.*$/gm," ");
 try {
  for (const span of extractTaskIntent(text).segments.quotedSpans) {
   if (span) text = text.split(span).join(" ");
  }
 } catch { /* segmentation is advisory; raw text still gates */ }
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
	const colon = model.lastIndexOf(":");
	if (colon < 0) return splitKnownThinkingSuffix(model);
	const parsed = splitKnownThinkingSuffix(`${model.slice(0, colon)}:${model.slice(colon + 1).toLowerCase()}`);
	return parsed.thinkingSuffix ? parsed : { baseModel: model, thinkingSuffix: "" };
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

/** Formatting aliases are accepted only when they identify one provider.
 * Literal/case-only names take precedence over separator aliases. */
function resolveProviderName(provider: string, availableModels: AvailableModelInfo[], names = [...new Set(availableModels.map(entry => entry.provider))]): string | false | undefined {
	provider = provider.trim();
	if (names.includes(provider)) return provider;
	const folded = names.filter(name => name.toLowerCase() === provider.toLowerCase());
	if (folded.length) return folded.length === 1 ? folded[0] : false;
	const key = (name: string) => name.toLowerCase().replace(/[._\s-]+/g, "");
	const formatted = names.filter(name => key(name) === key(provider));
	return formatted.length === 1 ? formatted[0] : formatted.length ? false : undefined;
}

/**
 * Split `provider/id` only when the first path segment is a registered provider.
 * Hugging Face-style `owner/name` ids therefore stay intact unless `owner` is
 * itself a provider in the active registry. `:` and `.` keep the same rule.
 */
function splitQualifiedModelQuery(
	baseModel: string,
	availableModels: AvailableModelInfo[],
): { queryProvider?: string; queryIdRaw: string; ambiguousProvider?: boolean } {
	// Prefer the longest registered provider prefix: providers may themselves
	// contain dots, and a colon/dot prefix may precede a namespaced vendor ID.
	const providers = [...new Set(availableModels.map(entry => entry.provider))];
	for (let index = baseModel.length - 1; index > 0; index--) {
		if (!"/:.".includes(baseModel[index]!)) continue;
		const provider = resolveProviderName(baseModel.slice(0, index), availableModels, providers);
		if (provider === false) return { ambiguousProvider: true, queryIdRaw: baseModel.slice(index + 1) };
		if (provider) return { queryProvider: provider, queryIdRaw: baseModel.slice(index + 1) };
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
		const provider = resolveProviderName(preferredProvider, availableModels);
		if (provider === false) return undefined;
		const preferredMatch = exactMatches.find((entry) => entry.provider === provider);
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

/** Last "/" segment (owner-agnostic leaf) of a normalized id. */
function leafSegment(normalizedId: string): string {
	const idx = normalizedId.lastIndexOf("/");
	return idx === -1 ? normalizedId : normalizedId.slice(idx + 1);
}

/** Word/number boundaries may be separated differently by catalogs. Preserve
 * digit groups so versions 3.8, 3.5 and 38 never become the same key. */
function modelFormatKey(id: string): string {
	const normalized = normalizeModelSegment(id.split("/").map(segment => segment.trim()).join("/").replace(/\s+/g, "-"))
		.replace(/([a-z])(\d)/g, "$1-$2").replace(/(\d)([a-z])/g, "$1-$2");
	return normalized.replace(/-(\d{4})(\d{2})(\d{2})$/, (match, year, month, day) =>
		isPlausibleDateStamp(year, month, day) ? `-${year}-${month}-${day}` : match);
}

function modelMatchRank(query: string, id: string): number | undefined {
	if (id.toLowerCase() === query.toLowerCase()) return 0;
	if (normalizeModelSegment(id) === normalizeModelSegment(query)) return 1;
	const wanted = modelFormatKey(query), candidate = modelFormatKey(id);
	if (candidate === wanted) return 2;
	const undated = stripTrailingDateStamp(candidate);
	const acceptsDateAlias = stripTrailingDateStamp(wanted) === wanted;
	if (acceptsDateAlias && undated === wanted) return 3;
	if (leafSegment(candidate) === leafSegment(wanted)) return 4;
	if (acceptsDateAlias && leafSegment(undated) === leafSegment(wanted)) return 5;
	return undefined;
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and unambiguous undated aliases so
 * users do not have to spell provider/model exactly. A slash is a provider
 * prefix only when that prefix is a registered provider; otherwise the whole
 * string is the model id (Hugging Face `owner/name`). When full ids differ,
 * an owner-agnostic leaf comparison rescues vendor owner renames (`z-ai/` vs
 * `zai-org/`) and bare-id configs. A qualified provider query only matches
 * within the named provider — this never silently switches providers for
 * security/cost-sensitive configs. Returns the matched `fullId`, or
 * `undefined` when there is no match or equally specific identities remain
 * ambiguous. An explicit dated revision never resolves to a different date.
 */
export function fuzzyResolveModel(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const { queryProvider, queryIdRaw, ambiguousProvider } = splitQualifiedModelQuery(baseModel.trim(), availableModels);
	if (ambiguousProvider || !queryIdRaw) return undefined;
	// An unknown leading provider in provider/owner/model must not disappear
	// through leaf matching. Exact nested vendor namespaces still work. An
	// ambient preferred provider is not authority to discard an unknown scope.
	const segments = queryIdRaw.split("/");
	const unresolvedScope = queryProvider === undefined
		&& (segments.length > 2 || segments.length > 1 && /[.:]/.test(segments[0]!));
	let candidates = availableModels.flatMap(entry => {
		if (queryProvider !== undefined && entry.provider !== queryProvider) return [];
		const rank = modelMatchRank(queryIdRaw, entry.id);
		return rank === undefined || unresolvedScope && rank >= 4 ? [] : [{ entry, rank }];
	});
	if (candidates.length === 0) return undefined;
	if (preferredProvider) {
		const provider = resolveProviderName(preferredProvider, availableModels);
		if (provider === false) return undefined;
		const preferred = candidates.filter(({ entry }) => entry.provider === provider);
		if (preferred.length) candidates = preferred;
	}
	const rank = Math.min(...candidates.map(candidate => candidate.rank));
	const routes = new Set(candidates.filter(candidate => candidate.rank === rank).map(candidate => candidate.entry.fullId));
	return routes.size === 1 ? [...routes][0] : undefined;
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
	// An explicit entry provider is a hard constraint, not a preference: a
	// leaf/owner-tolerant match must never silently resolve to a different
	// provider (cost/security-sensitive configs). The veto applies only to
	// bare queries: when the query itself names a provider, that explicit
	// choice is authoritative (explicit cross-provider requests must keep
	// working when the caller's preferred provider differs).
	const { queryProvider: queryNamesProvider } = splitQualifiedModelQuery(splitThinkingSuffix(model).baseModel, availableModels);
	const constrain = (route: string | undefined): string | undefined => {
		if (!route || !preferredProvider || queryNamesProvider !== undefined) return route;
		const winner = availableModels.find((entry) => entry.fullId === route);
		if (winner && winner.provider !== resolveProviderName(preferredProvider, availableModels)) return undefined;
		return route;
	};
	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return constrain(resolvedWhole);
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const resolvedBase = thinkingSuffix ? resolveBaseModelCandidate(baseModel, availableModels, preferredProvider) : undefined;
	if (!resolvedBase || !constrain(resolvedBase)) return undefined;
	return `${resolvedBase}${thinkingSuffix}`;
}

/**
 * Vendor-known-but-unpublished ids from the live catalog sidecar
 * (`live-model-catalog.json` per-provider `unavailable` map): models the
 * vendor lists but gates (paused, deprecated, wrong modality), so the
 * preference chain can report the true gate instead of "no match".
 * Best-effort and mtime-memoized; a missing/unreadable cache degrades to
 * the generic message.
 */
let unavailableSidecar: { stamp: string; byProvider: Map<string, Map<string, string>> } | undefined;
function readUnavailableSidecar(): Map<string, Map<string, string>> {
	let stamp = "";
	try {
		const file = join(getAgentDir(), "live-model-catalog.json");
		const stat = statSync(file);
		stamp = `${stat.mtimeMs}:${stat.size}`;
		if (unavailableSidecar && unavailableSidecar.stamp === stamp) return unavailableSidecar.byProvider;
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const providers = (parsed as { providers?: unknown })?.providers;
		const byProvider = new Map<string, Map<string, string>>();
		if (providers && typeof providers === "object") {
			for (const [providerId, entry] of Object.entries(providers as Record<string, unknown>)) {
				const unavailable = (entry as { unavailable?: unknown })?.unavailable;
				if (!unavailable || typeof unavailable !== "object") continue;
				const reasons = new Map<string, string>();
				for (const [id, reason] of Object.entries(unavailable as Record<string, unknown>)) {
					if (typeof id !== "string" || !id || typeof reason !== "string" || !reason) continue;
					if (reasons.size >= 512) break;
					reasons.set(id, reason.slice(0, 160));
				}
				if (reasons.size) byProvider.set(providerId, reasons);
			}
		}
		unavailableSidecar = { stamp, byProvider };
		return byProvider;
	} catch {
		if (unavailableSidecar && unavailableSidecar.stamp === stamp) return unavailableSidecar.byProvider;
		return new Map();
	}
}

function vendorUnavailableReason(provider: string, vendorId: string): string | undefined {
	if (!vendorId) return undefined;
	const reasons = readUnavailableSidecar().get(provider);
	if (!reasons) return undefined;
	const direct = reasons.get(vendorId);
	if (direct) return direct;
	const lowered = vendorId.toLowerCase();
	for (const [id, reason] of reasons) {
		if (id.toLowerCase() === lowered) return reason;
	}
	return undefined;
}

/** Drop a leading `provider/` segment so vendor ids compare cleanly. */
function stripProviderPrefix(query: string, provider: string): string {
	const prefix = `${provider.toLowerCase()}/`;
	return query.toLowerCase().startsWith(prefix) ? query.slice(prefix.length) : query;
}

function describeUnresolvedPreference(query: string, provider: string | undefined, availableModels: AvailableModelInfo[]): string {
	const trimmed = provider?.trim();
	if (trimmed) {
		const live = availableModels.filter((m) => normalizeModelSegment(m.provider) === normalizeModelSegment(trimmed));
		if (live.length === 0) {
			return `provider ${JSON.stringify(trimmed)} from llm_preferences has no models in this session's registry (not configured, not refreshed, or unavailable here) for ${JSON.stringify(query)}`;
		}
		const vendor = vendorUnavailableReason(trimmed, stripProviderPrefix(query, trimmed));
		return `no live registry match for ${JSON.stringify(query)} among ${live.length} live ${JSON.stringify(trimmed)} model${live.length === 1 ? "" : "s"}${vendor ? ` (vendor reports: ${vendor})` : ""}`;
	}
	return `no live registry match for ${JSON.stringify(query)}`;
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
	/** Explicit canonical document for editor diagnostics; runtime callers use the configured path. */
	configPath?: string;
	requirements?: LlmPreferenceRequirements;
	/** Restrict the chain to proven-free routes (explicit free-only tasks). */
	freeOnly?: boolean;
	/** Optional diagnostic sink. Called only for configured entries skipped by
	 * the same checks that govern runtime selection. */
	onSkip?: (event: { role: string; priority: number; route: string; reason: string }) => void;
}

/**
 * Ordered viable preference routes for a role. Each entry is validated
 * against the live registry (fuzzy resolution), cached exclusions, shared
 * provider-health cooldowns and capability requirements; unusable entries
 * are skipped and the chain continues. Explicit user preferences bypass
 * economy price caps but never health, exclusion or capability gates —
 * except tool-calling proof: catalog facts exist only for OpenRouter and
 * OrcaRouter with fresh evidence, so unknown tool support passes here (the
 * user's explicit configuration is the positive evidence) and only a
 * known-negative blocks. Autonomous selection keeps requiring positive
 * tool proof. Returns [] when the file is missing, malformed or has no
 * viable entry, in which case callers use the existing autonomous selection.
 */
export function resolveLlmPreferenceChain(
	role: string,
	availableModels: AvailableModelInfo[] | undefined,
	options?: LlmPreferenceOptions,
): LlmPreferenceRoute[] {
	const loaded = loadLlmPreferences(options?.configPath);
	if (!loaded.ok && !loaded.missing) warnOnceEconomy(`${loaded.path}::${loaded.reason ?? "unknown"}`, "preference-load", `[pi-subagents] llm_preferences (${role}): ignoring preference file (${loaded.reason ?? "unknown reason"}); autonomous selection applies`);
	if (!loaded.ok || !loaded.config || !availableModels || availableModels.length === 0) return [];
	for (const warning of loaded.warnings ?? []) warnOnceEconomy(`${loaded.path}::${warning}`, "preference-entry", `[pi-subagents] llm_preferences: ${warning}; valid entries remain active`);
	const entries = preferenceEntriesFor(role, loaded.config);
	return resolvePreferenceEntries(role, availableModels, options, entries);
}

function resolvePreferenceEntries(role: string, availableModels: AvailableModelInfo[], options: LlmPreferenceOptions | undefined, entries: LlmModelEntry[]): LlmPreferenceRoute[] {
	if (!entries.length) return [];
	const out: LlmPreferenceRoute[] = [];
	const seen = new Set<string>();
	const now = Date.now();
	const exhausted = new Set(exhaustedProvidersOf(availableModels) ?? []);
	let health: ReturnType<typeof readHealth> | undefined;
	for (const [entryIndex, entry] of entries.entries()) {
		const requested = entry.provider ? `${entry.provider}/${entry.model ?? ""}` : (entry.model ?? "");
		const reportSkip = (route: string, reason: string) => {
			try { options?.onSkip?.({ role, priority: entryIndex + 1, route: route || requested, reason }); } catch { /* diagnostics must not affect selection */ }
		};
		// The provider field is authoritative even when the vendor model ID
		// contains an owner namespace which is also a registered provider.
		const provider = entry.provider ? resolveProviderName(entry.provider, availableModels) || entry.provider : undefined;
		const query = provider ? `${provider}/${stripProviderPrefix(entry.model ?? "", provider)}` : (entry.model ?? "");
		if (!query) continue;
		const suffix = splitThinkingSuffix(query);
		const resolved = resolveSubagentModelCandidate(suffix.baseModel, availableModels, provider);
		if (!resolved) {
			reportSkip(query, "unavailable in this session's model registry");
			warnOnceEconomy(query, "preference-unresolved", `[pi-subagents] llm_preferences (${role}): ${describeUnresolvedPreference(query, entry.provider, availableModels)}; continuing chain`);
			noteHealth("model.skip", { route: query, outcome: "unresolved" });
			continue;
		}
		const base = splitThinkingSuffix(resolved).baseModel;
		const exclusion = findModelExclusion(base);
		if (exclusion) {
			reportSkip(base, `excluded until ${new Date(exclusion.expiresAt).toISOString()}${exclusion.reason ? `: ${exclusion.reason}` : ""}`);
			warnOnceEconomy(base, "preference-excluded", `[pi-subagents] llm_preferences (${role}): skipping ${base} (excluded until ${new Date(exclusion.expiresAt).toISOString()}: ${exclusion.reason ?? "no reason"}); continuing chain`);
			noteHealth("model.skip", { route: base, outcome: "excluded" });
			continue;
		}
		const info = availableModels.find((entry) => entry.fullId === base);
		if (!info) { reportSkip(base, "not present in the active model registry"); continue; }
		const translated = providerOptionsToRouting(entry.provider_options, info.provider);
		const routingMode = entry.provider_options?.routing;
		if (translated.note && routingMode !== undefined && (typeof routingMode !== "string" || routingMode.trim().toLowerCase() !== "auto")) {
			reportSkip(base, translated.note);
			continue;
		}
		const identity = `${base.toLowerCase()}\u0000${stableRouteJson(translated.routing ?? null)}`;
		if (seen.has(identity)) { reportSkip(base, "duplicate route and provider settings"); continue; }
		if (!health) health = readHealth();
		try {
			const decision = evaluateRoute({ provider: info.provider, model: info.id, now }, health);
			if (!decision.allowed) {
				reportSkip(base, `provider cooling until ${new Date(decision.cooldownUntil).toISOString()}`);
				warnOnceEconomy(base, "preference-cooling", `[pi-subagents] llm_preferences (${role}): skipping ${base} (route cooling until ${new Date(decision.cooldownUntil).toISOString()}); continuing chain`);
				noteHealth("model.skip", { route: base, outcome: "cooling" });
				continue;
			}
		} catch { reportSkip(base, "provider health could not be verified"); continue; }
		const req = options?.requirements;
		const rejection = exhausted.has(info.provider) ? "provider quota exhausted"
			: req?.minContextWindow !== undefined && !(typeof info.contextWindow === "number" && info.contextWindow >= req.minContextWindow) ? "insufficient context window"
			: req?.minOutputTokens !== undefined && !(typeof info.maxTokens === "number" && info.maxTokens >= req.minOutputTokens) ? "insufficient output capacity"
			: req?.reasoning === true && info.reasoning !== true ? "required reasoning unavailable"
			: req?.inputModalities?.some((input) => !info.input?.includes(input)) ? "required input modality unavailable"
			: req?.toolCalling && catalogRouteCapabilities(info)?.toolCalling === false ? "tool calling unsupported"
			: options?.freeOnly && !isProvenFreeRoute(info) ? "explicit free-only constraint" : undefined;
		if (rejection) {
			reportSkip(base, rejection);
			warnOnceEconomy(`${role}:${base}`, `preference-${rejection}`, `[pi-subagents] llm_preferences (${role}): skipping ${base} (${rejection}); continuing chain`);
			noteHealth("model.skip", { route: base, outcome: "ineligible", reason: rejection, role });
			continue;
		}
		const wanted = suffix.thinkingSuffix ? suffix.thinkingSuffix.slice(1) : entry.thinking;
		const norm = normalizeThinking(wanted);
		const thinking = !norm.dynamic && norm.thinking ? clampSupportedThinkingLevel(info, norm.thinking) : undefined;
		seen.add(identity);
		out.push({
			route: base,
			...(thinking ? { thinking } : {}),
			dynamicThinking: !thinking,
			...(translated.routing ? { providerRouting: translated.routing } : {}),
			explanation: [`explicit llm_preferences (${role})`, ...(thinking ? [thinking === norm.thinking ? `thinking ${thinking}` : `thinking ${thinking} (requested ${norm.thinking} is unsupported)`] : ["dynamic thinking"]), ...(translated.routing ? ["openrouter backend routing"] : [])],
		});
	}
	return out;
}

export interface SessionObserverPreferenceSelection {
	source: "default" | "session_observer";
	status: "ready" | "disabled" | "unavailable";
	routes: LlmPreferenceRoute[];
	reason?: string;
}

/** Shared observer admission floor for its 8,000-byte packet and bounded answer. */
export const SESSION_OBSERVER_REQUIREMENTS: Readonly<LlmPreferenceRequirements> = Object.freeze({
	inputModalities: ["text"], minContextWindow: 12288, minOutputTokens: 4096,
});

/** An optional observer has a fixed default, not autonomous routing. Callers
 * supply authenticated available models and attempt at most one selected route.
 * An explicit empty role opts out; corrupt config never enables the default. */
export function resolveSessionObserverPreferenceChain(availableModels: AvailableModelInfo[] | undefined, options?: LlmPreferenceOptions): SessionObserverPreferenceSelection {
	const loaded = readLlmPreferencesDocument(options?.configPath);
	const unavailable = (source: "default" | "session_observer", reason: string): SessionObserverPreferenceSelection => ({ source, status: "unavailable", routes: [], reason });
	if (loaded.exists && !loaded.ok) return unavailable("session_observer", "Observer preferences could not be read or validated.");
	const keys = Object.keys((loaded.document?.preferences ?? {}) as object).filter(key => normalizePreferenceRole(key) === SESSION_OBSERVER_ROLE);
	if (keys.length > 1) return unavailable("session_observer", "Observer preferences contain duplicate role names.");
	const explicit = keys.length === 1;
	const source = explicit ? "session_observer" : "default";
	const raw = explicit ? (loaded.document!.preferences as Record<string, any>)[keys[0]!] : undefined;
	const list = Array.isArray(raw) ? raw : raw?.models;
	if (explicit && !Array.isArray(list)) return unavailable(source, "Observer model list is invalid.");
	if (explicit && !list.length) return { source, status: "disabled", routes: [] };
	if (explicit) {
		// Validate this role and only its referenced aliases strictly. The general
		// loader intentionally tolerates malformed entries for other workloads.
		const registry = (loaded.document?.models ?? {}) as Record<string, unknown>;
		const aliases = Object.fromEntries(list.filter((item: unknown) => typeof item === "string" && Object.hasOwn(registry, item.trim())).map((item: string) => [item.trim(), registry[item.trim()]]));
		const checked = validateLlmPreferencesDocumentForWrite({ models: aliases, preferences: { [SESSION_OBSERVER_ROLE]: raw } });
		if (!checked.ok) return unavailable(source, "Observer model entries are invalid.");
	}
	const entries = explicit && loaded.config ? preferenceEntriesFor(SESSION_OBSERVER_ROLE, loaded.config) : [{ ...SESSION_OBSERVER_DEFAULT }];
	if (!entries.length) return unavailable(source, "Observer model entries could not be resolved.");
	const models = availableModels ?? [];
	const requirements: LlmPreferenceRequirements = {
		...options?.requirements,
		inputModalities: [...new Set(["text", ...(options?.requirements?.inputModalities ?? [])])],
		minContextWindow: Math.max(SESSION_OBSERVER_REQUIREMENTS.minContextWindow!, options?.requirements?.minContextWindow ?? 0),
		minOutputTokens: Math.max(SESSION_OBSERVER_REQUIREMENTS.minOutputTokens!, options?.requirements?.minOutputTokens ?? 0),
	};
	const routes: LlmPreferenceRoute[] = [];
	const seen = new Set<string>();
	for (const [entryIndex, entry] of entries.entries()) {
		const reportSkip = (route: string, reason: string) => {
			try { options?.onSkip?.({ role: SESSION_OBSERVER_ROLE, priority: entryIndex + 1, route, reason }); } catch { /* diagnostics must not affect selection */ }
		};
		// Aliases are already expanded. Only canonical formatting is flexible:
		// observer routes never use owner/leaf or undated revision substitutions.
		const query = splitThinkingSuffix(entry.model ?? "").baseModel;
		const qualified = splitQualifiedModelQuery(query, models);
		const provider = entry.provider ? resolveProviderName(entry.provider, models) : qualified.queryProvider;
		if (provider === false || entry.provider && !provider || !entry.provider && qualified.ambiguousProvider) {
			reportSkip(query, "configured provider is unavailable or ambiguous");
			continue;
		}
		const formatted = models.flatMap(model => {
			if (provider && model.provider !== provider) return [];
			if (source === "default" && (model.provider !== SESSION_OBSERVER_DEFAULT.provider || model.id !== SESSION_OBSERVER_DEFAULT.model)) return [];
			const queries = [query, ...(qualified.queryProvider === model.provider ? [qualified.queryIdRaw] : [])];
			const rank = Math.min(...queries.map(value => modelMatchRank(value, model.id) ?? Infinity));
			return rank <= 2 ? [{ model, rank }] : [];
		});
		const bestRank = Math.min(...formatted.map(candidate => candidate.rank));
		const exact = formatted.filter(candidate => candidate.rank === bestRank).map(candidate => candidate.model);
		if (new Set(exact.map(model => `${model.provider}/${model.id}`)).size > 1) {
			reportSkip(query, "model ID is ambiguous; configure its provider");
			continue;
		}
		const pool = exact.filter(model => {
			// The Codex native request has no finite output allowance on the wire.
			// It remains available to ordinary agent roles, but cannot run observers.
			if (model.api === "openai-codex-responses") {
				reportSkip(`${model.provider}/${model.id}`, "API cannot enforce the observer output limit");
				return false;
			}
			return model.provider !== "deepseek" || model.id !== "deepseek-flash"
				|| ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(model.baseUrl?.replace(/\/$/, "") ?? "");
		});
		const canonicalEntry = pool[0] ? { ...entry, provider: pool[0].provider, model: `${pool[0].provider}/${pool[0].id}${splitThinkingSuffix(entry.model ?? "").thinkingSuffix}` } : entry;
		const candidates = resolvePreferenceEntries(SESSION_OBSERVER_ROLE, pool, { ...options, requirements, onSkip: skip => reportSkip(skip.route, skip.reason) }, [canonicalEntry]);
		const wanted = normalizeThinking(splitThinkingSuffix(entry.model ?? "").thinkingSuffix.slice(1) || entry.thinking);
		for (const candidate of candidates) {
			if (!wanted.dynamic && candidate.thinking !== wanted.thinking) {
				reportSkip(candidate.route, `configured thinking ${wanted.thinking} is unsupported`);
				continue;
			}
			const identity = `${candidate.route.toLowerCase()}\u0000${stableRouteJson(candidate.providerRouting ?? null)}`;
			if (seen.has(identity)) { reportSkip(candidate.route, "duplicate route and provider settings"); continue; }
			seen.add(identity);
			routes.push(candidate);
		}
	}
	return routes.length ? { source, status: "ready", routes } : unavailable(source, "No configured observer route is authenticated, supported and available; no fallback was selected.");
}

function stableRouteJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableRouteJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableRouteJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** First viable preference for a role, or undefined for autonomous fallback. */
export function selectLlmPreferredModel(
	role: string,
	availableModels: AvailableModelInfo[] | undefined,
	options?: LlmPreferenceOptions,
): LlmPreferenceRoute | undefined {
	return resolveLlmPreferenceChain(role, availableModels, options)[0];
}

export interface PromptAnalysisPreferenceSelection {
	source: "prompt_analysis" | "subagents" | "autonomous";
	routes: LlmPreferenceRoute[];
}

/** Prefer the explicit lightweight analysis role, then inherit the same
 * user's ordered subagent routes for older or deliberately reset configs. */
export function resolvePromptAnalysisPreferenceChain(
	availableModels: AvailableModelInfo[] | undefined,
	options?: LlmPreferenceOptions,
): PromptAnalysisPreferenceSelection {
	const loaded = loadLlmPreferences(options?.configPath);
	const explicit = loaded.ok && loaded.config?.preferences.prompt_analysis?.models.length
		? resolveLlmPreferenceChain("prompt_analysis", availableModels, options)
		: [];
	if (explicit.length) return { source: "prompt_analysis", routes: explicit };
	const inherited = resolveLlmPreferenceChain("subagents", availableModels, options);
	if (inherited.length) return { source: "subagents", routes: inherited };
	return { source: "autonomous", routes: [] };
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
	/** Dispatch session identity; it does not change declared preference order. */
	sessionId?: string;
	/** Child-specific route bounds; derived from `task` when omitted. */
	child?: ChildRouteRequirements;
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
	// Preferences are independent of autonomous pricing and session usage counts.
	// Explicit per-call/agent routes and task route locks remain authoritative.
	if (explicit === undefined && options?.task) {
		const constraints = taskRouteConstraints(options.task);
		const preferred = constraints.fixed ? undefined : selectLlmPreferredModel(inferPreferenceRole(options.task), availableModels, {
			freeOnly: constraints.freeOnly, requirements: options.child ?? childFor(options.task),
		});
		if (preferred) {
			const route = withLlmThinkingSuffix(preferred);
			enforceModelScopes(route, options?.scope, "inherited", options?.onWarn);
			return route;
		}
	}
	// A user free-only constraint is independent of optional economy pricing.
	// Missing metadata or a disabled economy policy must not admit paid work.
	const routeConstraints = taskRouteConstraints(options?.task);
	if (routeConstraints.freeOnly) {
		if (explicit === undefined && !routeConstraints.fixed) {
			const pick = selectAffordableModel(availableModels, loadModelEconomyConfig(), {
				task: options?.task, freeOnly: true, preferredModel: resolved,
				exhaustedProviders: exhaustedProvidersOf(availableModels), child: options?.child ?? childFor(options?.task),
			});
			if (pick) { enforceModelScopes(pick.model, options?.scope, "inherited", options?.onWarn); return pick.model; }
		}
		if (!resolved || !isProvenFreeRoute(economyRouteInfo(resolved, availableModels).info)) {
			throw new Error("No eligible free route satisfies this task; keep the work in the parent. Paid assistance was not admitted.");
		}
	}
	if (resolved) {
		const cfg = loadModelEconomyConfig();
		if (cfg.enabled && registryHasPricing(availableModels)) {
			const { info } = economyRouteInfo(resolved, availableModels);
			if (info) {
				const classification = classifyModelEconomy(splitThinkingSuffix(resolved).baseModel, info, cfg);
				if (explicit === undefined && options?.task) {
     const constraints=taskRouteConstraints(options.task);
     const child = options?.child ?? childFor(options?.task);
     const pick = constraints.fixed ? undefined : selectAffordableModel(availableModels,cfg,{task:options.task,freeOnly:constraints.freeOnly,preferredModel:resolved,exhaustedProviders:exhaustedProvidersOf(availableModels),...(child ? {child} : {})});
     if (pick) { enforceModelScopes(pick.model,options?.scope,"inherited",options?.onWarn); return pick.model; }
     if (["expensive","zero-placeholder"].includes(classification.verdict) || constraints.freeOnly && !isProvenFreeRoute(info)) throw new Error(`${formatEconomyNoRouteMessage(resolved,cfg)} No affordable route passed the task quality/route constraints. ${formatAffordableSelectionDiagnostics(availableModels,cfg,{task:options.task,freeOnly:constraints.freeOnly,preferredModel:resolved,exhaustedProviders:exhaustedProvidersOf(availableModels)})} Keep this work in the parent or supply verified benchmark evidence.`);
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

function shouldUseLlmPreferenceFallbacks(
	fallbackModels: string[] | undefined,
	options: BuildModelCandidatesOptions | undefined,
	origin: ModelOrigin,
): boolean {
	const task = options?.task ?? "";
	const pinsRoute = /\b(?:only use|use only|stick to|stay on)\b(?!\s+(?:the\s+)?free\b)|\b(?:same|current|this)\s+(?:model|provider)\s+only\b|\b(?:no|disable|do not|don't|never)\s+(?:(?:allow|enable)\s+)?(?:(?:automatic|model|provider)\s+)*fallbacks?\b|\b(?:do not|don't|never)\s+(?:switch|change)\s+(?:the\s+)?(?:provider|model)\b/i.test(task);
	return options?.allowAutomaticAlternatives !== false
		&& origin === "inherited"
		&& !pinsRoute
		&& !fallbackModels?.length
		&& process.env.PI_AUTONOMOUS_MODEL_FALLBACK !== "off";
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
	if (resolved.length === 0 && shouldUseLlmPreferenceFallbacks(fallbackModels, options, origin)) {
		const constraints = taskRouteConstraints(options?.task);
		for (const preference of resolveLlmPreferenceChain(inferPreferenceRole(options?.task), availableModels, { freeOnly: constraints.freeOnly, requirements: childFor(options?.task) })) {
			const route = withLlmThinkingSuffix(preference);
			try { enforceModelScopes(route, scopes, "inherited", options?.onWarn); } catch { continue; }
			resolved.push(route);
			break;
		}
	}
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
	// Raw text (not segmented): quoted mentions still pin automatic
	// alternatives here. The free lookahead matches taskRouteConstraints: a
	// free-only task receives free alternatives, never paid ones.
	const autoConstraints=taskRouteConstraints(options?.task);
	if(shouldUseLlmPreferenceFallbacks(fallbackModels, options, origin)) {
		const preferredFallbacks = resolveLlmPreferenceChain(inferPreferenceRole(options?.task), availableModels, { freeOnly: autoConstraints.freeOnly, requirements: childFor(options?.task) });
		const seenPreferenceVariants = new Set<string>();
		for (const pref of preferredFallbacks) {
			if (economical.length >= 8) break;
			const identity = modelRouteCandidateKey({ route: pref.route, providerRouting: pref.providerRouting });
			if (seenPreferenceVariants.has(identity)) continue;
			seenPreferenceVariants.add(identity);
			const prefRoute = withLlmThinkingSuffix(pref);
			// A plain primary with the same model still needs an explicit pinned
			// attempt. Distinct provider pins are separate retries even when the
			// canonical registry route is identical.
			if (!pref.providerRouting && economical.includes(prefRoute)) continue;
			if (!pref.providerRouting && economical.some(e => splitKnownThinkingSuffix(e).baseModel === pref.route)) continue;
			try { enforceModelScopes(prefRoute, scopes, "inherited", options?.onWarn); } catch { continue; }
			economical.push(prefRoute);
		}
		// A retained parent/autonomous candidate follows every configured route.
		// Consume occurrences in preference order. Sorting by model ID merges
		// separate upstream variants and lets a later A pin move the first A
		// behind B in an A/Together, B, A/Friendli chain.
		const remaining = economical.splice(0);
		for (const preference of preferredFallbacks) {
			const index = remaining.findIndex(route => splitThinkingSuffix(route).baseModel === preference.route);
			if (index < 0) continue;
			remaining.splice(index, 1);
			economical.push(withLlmThinkingSuffix(preference));
		}
		economical.push(...remaining);
		const cfg=loadModelEconomyConfig();
		const first=availableModels?.find(model=>model.fullId===splitKnownThinkingSuffix(economical[0]).baseModel);
		if(cfg.enabled&&first&&Number.isSafeInteger(first.contextWindow)&&first.contextWindow!>0&&Number.isSafeInteger(first.maxTokens)&&first.maxTokens!>0) {
			const evidence=readFreeEvidence();const freeOnly=autoConstraints.freeOnly||isProvenFreeRoute(first,evidence);
			const pool=(availableModels??[]).filter(model=>Number.isSafeInteger(model.contextWindow)&&model.contextWindow!>=first.contextWindow!
				&&Number.isSafeInteger(model.maxTokens)&&model.maxTokens!>=first.maxTokens!
				&&(!first.reasoning||model.reasoning===true)&&(!first.input||first.input.every(input=>model.input?.includes(input)))
				&&catalogRouteCapabilities(model,evidence)?.toolCalling===true
				&&(isProvenFreeRoute(model,evidence)||!freeOnly&&isAutonomousMeteredEligible(model,cfg)));
			const excluded=[...economical];
			for(let attempts=0;attempts<8&&economical.length<Math.min(8, Math.max(3, preferredFallbacks.length + 1));attempts++) {
				const choice=selectAffordableModel(pool,cfg,{task:options?.task,preferredModel:first.fullId,exclude:excluded,exhaustedProviders:exhaustedProvidersOf(availableModels)});
				if(!choice)break;excluded.push(choice.model);
				try {enforceModelScopes(choice.model,scopes,"explicit",options?.onWarn);}catch {continue;}
				economical.push(choice.model);
			}
		}
	}
	return economical;
}

/** Ordered child retry candidates with their exact request-scoped upstream
 * routing. The string-only helper remains for display/legacy callers; child
 * launch paths use this paired form so a saved pin reaches the API request. */
export function buildModelRouteCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: BuildModelCandidatesOptions,
): ModelRouteCandidate[] {
	const candidates = buildModelCandidates(primaryModel, fallbackModels, availableModels, preferredProvider, options);
	if (!availableModels?.length) return candidates.map((route) => ({ route }));
	const origin = options?.origin ?? (options?.primaryModelFromParent ? "inherited" : "configured");
	if (!shouldUseLlmPreferenceFallbacks(fallbackModels, options, origin)) return candidates.map((route) => ({ route }));
	const constraints = taskRouteConstraints(options?.task);
	const preferences = resolveLlmPreferenceChain(inferPreferenceRole(options?.task), availableModels, {
		freeOnly: constraints.freeOnly,
		requirements: childFor(options?.task),
	});
	const byRoute = new Map<string, LlmPreferenceRoute[]>();
	for (const preference of preferences) {
		const key = preference.route.toLowerCase();
		const queue = byRoute.get(key) ?? [];
		queue.push(preference);
		byRoute.set(key, queue);
	}
	return candidates.map((route) => {
		const base = splitKnownThinkingSuffix(route).baseModel.toLowerCase();
		const preference = byRoute.get(base)?.shift();
		return {
			route,
			...(preference?.providerRouting ? { providerRouting: preference.providerRouting } : {}),
		};
	});
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
	if (isLocalModelResolutionFailure(error)) return true;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

function messageError(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = (message as { errorMessage?: unknown }).errorMessage;
	return typeof value === "string" ? value : undefined;
}

export function isRetryableModelFailureAttempt(input: { error: string | undefined; messages?: readonly unknown[]; toolCount?: number }): boolean {
	// A failed local launch may advance the already-admitted route chain, but
	// cannot justify replaying a child that has started model or tool work.
	if (isLocalModelResolutionFailure(input.error)) return (input.toolCount ?? 0) === 0 && (input.messages?.length ?? 0) === 0;
	if (!isRetryableModelFailure(input.error)) return false;
	if ((input.toolCount ?? 0) > 0) return false;
	if (input.error === "Subagent produced no output (possible model cold-start or empty response)." || /^Subagent produced no output after terminal assistant stopReason "[^"]+"\.$/.test(input.error ?? "")) return true;
	if ((input.toolCount ?? 0) === 0 && (input.messages?.length ?? 0) === 0) return true;
	const error = input.error?.trim();
	return Boolean(error && input.messages?.some((message) => messageError(message)?.trim() === error));
}

export function recordRetryableModelFailure(model: string | undefined, error: string | undefined): void {
	if (isLocalModelResolutionFailure(error)) return;
	if (!model || !isRetryableModelFailure(error)) return;
	// A terminal "length" stop means the harness output budget was exhausted
	// before the model emitted text — a budget fault, never a model defect.
	// Excluding the healthy route for 24h is never correct (2026-09-16: this
	// removed the preferred subagent route for a full day and forced
	// automatic assistance onto dead providers). Warn loudly instead.
	if (/stopReason "length"/.test(error ?? "")) {
		warnOnceEconomy(model, "length-stop", `[pi-subagents] NOT excluding ${model}: terminal "length" stop exhausts the harness output budget, not a model failure (${(error ?? "").slice(0, 160)})`);
		noteHealth("model.skip", { route: splitThinkingSuffix(model).baseModel || model, outcome: "length-stop" });
		return;
	}
	// A "not found" failure for a thinking-suffixed ID indicts the harness
	// composition, not the provider: the base model was selected from the
	// live registry, so only our appended suffix can be unknown. Excluding
	// the healthy base model for our bad ID is never correct — warn loudly
	// instead. Bare-ID 404s still record (stale catalog entries must cool
	// off so dispatch stops proposing them).
	if (isHarnessComposedIdFailure(model, error)) {
		warnOnceEconomy(model, "harness-composed-id", `[pi-subagents] NOT excluding ${model}: "not found" for a thinking-suffixed ID is a harness composition failure, not a provider failure (${(error ?? "").slice(0, 160)})`);
		noteHealth("model.skip", { route: splitThinkingSuffix(model).baseModel || model, outcome: "suffix-404" });
		return;
	}
	const { provider, modelId } = parseModelKey(model);
	recordModelFailure({ modelId, reason: error, ...(provider ? { provider } : {}) });
}

const NOT_FOUND_FAILURE = /not found|unknown model/i;

function isHarnessComposedIdFailure(model: string, error: string | undefined): boolean {
	if (!NOT_FOUND_FAILURE.test(error ?? "")) return false;
	if (splitThinkingSuffix(model).thinkingSuffix) return true;
	const quoted = /"([^"]+)" not found/i.exec(error ?? "")?.[1] ?? /unknown model[:\s]+(\S+)/i.exec(error ?? "")?.[1];
	return quoted ? splitThinkingSuffix(quoted).thinkingSuffix !== "" : false;
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
 const constraints=taskRouteConstraints(task);
 const child = origin === "inherited" && task ? childFor(task) : undefined;
 const preferences = origin === "inherited" && task && !constraints.fixed
  ? resolveLlmPreferenceChain(inferPreferenceRole(task), availableModels, { freeOnly: constraints.freeOnly, requirements: child }) : [];
 if (preferences.length) {
  const first = withLlmThinkingSuffix(preferences[0]);
  candidates = [first, ...candidates.filter(route => splitThinkingSuffix(route).baseModel !== preferences[0].route)];
 }
 const preferredRoutes = new Set(preferences.map(preference => preference.route));
 if (origin === "inherited" && task && !preferences.length && (constraints.freeOnly || cfg.enabled && registryHasPricing(availableModels))) {
  const pick=constraints.fixed ? undefined : selectAffordableModel(availableModels,cfg,{task,freeOnly:constraints.freeOnly,preferredModel:candidates[0],exhaustedProviders:exhaustedProvidersOf(availableModels),...(child ? {child} : {})});
  if (pick) candidates=[pick.model,...candidates.slice(1).filter(route=>route!==pick.model)];
  else if (constraints.freeOnly && !isProvenFreeRoute(economyRouteInfo(candidates[0],availableModels).info)) throw new Error("No eligible free route satisfies this task; keep the work in the parent. Paid assistance was not admitted.");
 }
 if (constraints.freeOnly) {
  candidates = candidates.filter((route, index) => {
   if (isProvenFreeRoute(economyRouteInfo(route, availableModels).info)) return true;
   if (index === 0) throw new Error("Free-only task refused a route without current free pricing evidence.");
   return false;
  });
 }
 if (!cfg.enabled || !registryHasPricing(availableModels) || candidates.length === 0) return constraints.fixed ? candidates.slice(0, 1) : candidates;
	const kept: string[] = [];
	let primaryDropped = false;
	for (let index = 0; index < candidates.length; index++) {
		const route = candidates[index]!;
		const { info, base } = economyRouteInfo(route, availableModels);
		const isPrimary = index === 0;
		if (!info) {
			kept.push(route);
			continue;
		}
		if (preferredRoutes.has(base)) {
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
		if (!isPrimary && unaffordable) continue;
		if (classification.verdict === "unknown-price") warnOnceEconomy(base, "unknown", formatEconomyUnknownWarning(base, cfg));
		kept.push(route);
	}
	let result = kept;
	if (primaryDropped) {
		const pick = constraints.fixed ? undefined : selectAffordableModel(availableModels, cfg, { task, freeOnly:constraints.freeOnly, preferredModel: candidates[0]!, exclude: [candidates[0]!, ...kept], exhaustedProviders: exhaustedProvidersOf(availableModels), ...(child ? {child} : {}) });
		if (!pick) throw new Error(`${formatEconomyNoRouteMessage(candidates[0]!, cfg)}${task ? ` No route passed the task quality gate. ${formatAffordableSelectionDiagnostics(availableModels,cfg,{task,freeOnly:constraints.freeOnly,preferredModel:candidates[0]!,exclude:[candidates[0]!,...kept],exhaustedProviders:exhaustedProvidersOf(availableModels)})} Keep this work in the parent or supply verified model evidence.` : ""}`);
		result = [pick.model, ...kept.filter((route) => route !== pick.model)];
	}
	return constraints.fixed ? result.slice(0,1) : result;
}
