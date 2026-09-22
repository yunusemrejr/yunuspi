import { performance } from "node:perf_hooks";
import { recordModelRoutingLatency } from "./model-routing-metrics.ts";
import {
	LLM_PREFERENCES_VERSION,
	readLlmPreferencesDocument,
	saveLlmPreferencesDocument,
	validateLlmPreferencesDocumentForWrite,
} from "../pi-subagents/src/runs/shared/llm-preferences.ts";

export interface ModelRoutingCatalogItem {
	provider: string;
	id: string;
	fullId: string;
	name?: string;
	api?: string;
	providerHost?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	cost?: { input?: number; output?: number; knownFree?: boolean };
	enabled: boolean;
	globalProviderRouting?: Record<string, unknown>;
}

export interface ModelRoutingSnapshot {
	ok: boolean;
	revision: string;
	exists: boolean;
	document?: Record<string, unknown>;
	configPath: string;
	reason?: string;
	warnings?: string[];
	backupAvailable: boolean;
	strictWriteError?: string;
	models: ModelRoutingCatalogItem[];
}

export interface ModelRoutingRegistry {
	getAll?: () => unknown[];
	getAvailable?: () => unknown[];
}

function safeString(value: unknown, max = 256): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

function providerHost(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		return url.hostname.toLowerCase();
	} catch { return undefined; }
}

function publicModel(model: any, enabled: boolean): ModelRoutingCatalogItem | undefined {
	const provider = safeString(model?.provider, 128);
	const id = safeString(model?.id, 512);
	if (!provider || !id || id.includes("\n")) return undefined;
	const cost = model?.cost && typeof model.cost === "object" ? {
		...(typeof model.cost.input === "number" && Number.isFinite(model.cost.input) && model.cost.input >= 0 ? { input: model.cost.input } : {}),
		...(typeof model.cost.output === "number" && Number.isFinite(model.cost.output) && model.cost.output >= 0 ? { output: model.cost.output } : {}),
		...(typeof model.cost.knownFree === "boolean" ? { knownFree: model.cost.knownFree } : {}),
	} : undefined;
	const routing = model?.compat?.openRouterRouting;
	return {
		provider,
		id,
		fullId: `${provider}/${id}`,
		...(safeString(model?.name) ? { name: safeString(model.name) } : {}),
		...(safeString(model?.api, 128) ? { api: safeString(model.api, 128) } : {}),
		...(providerHost(model?.baseUrl) ? { providerHost: providerHost(model.baseUrl) } : {}),
		...(Number.isSafeInteger(model?.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
		...(Number.isSafeInteger(model?.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
		...(typeof model?.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
		...(Array.isArray(model?.input) ? { input: model.input.filter((item: unknown) => typeof item === "string" && item.length <= 32).slice(0, 8) } : {}),
		...(cost ? { cost } : {}),
		enabled,
		...(routing && typeof routing === "object" && !Array.isArray(routing) ? { globalProviderRouting: routing } : {}),
	};
}

function catalog(registry: ModelRoutingRegistry): ModelRoutingCatalogItem[] {
	let all: unknown[] = [];
	let enabled: unknown[] = [];
	try { all = Array.isArray(registry.getAll?.()) ? registry.getAll!() : []; } catch { all = []; }
	try { enabled = Array.isArray(registry.getAvailable?.()) ? registry.getAvailable!() : []; } catch { enabled = []; }
	const enabledKeys = new Set(enabled.flatMap((row: any) => {
		const provider = safeString(row?.provider, 128), id = safeString(row?.id, 512);
		return provider && id ? [`${provider.toLowerCase()}/${id.toLowerCase()}`] : [];
	}));
	const source = all.length ? all : enabled;
	const out = new Map<string, ModelRoutingCatalogItem>();
	for (const row of source.slice(0, 12000)) {
		const candidate = publicModel(row, enabledKeys.has(`${String((row as any)?.provider ?? "").toLowerCase()}/${String((row as any)?.id ?? "").toLowerCase()}`));
		if (candidate) out.set(candidate.fullId.toLowerCase(), candidate);
	}
	return [...out.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

export function readModelRoutingSnapshot(configPath: string, registry: ModelRoutingRegistry): ModelRoutingSnapshot {
	const started = performance.now();
	const current = readLlmPreferencesDocument(configPath);
	const backup = readLlmPreferencesDocument(`${configPath}.bak`);
	const document = current.document ?? (!current.exists ? { version: LLM_PREFERENCES_VERSION, models: {}, preferences: {} } : undefined);
	const strict = document ? validateLlmPreferencesDocumentForWrite(document) : undefined;
	const snapshot = {
		ok: current.ok,
		revision: current.revision,
		exists: current.exists,
		...(document ? { document } : {}),
		configPath,
		...(current.reason ? { reason: current.reason } : {}),
		...(current.warnings ? { warnings: current.warnings } : {}),
		backupAvailable: backup.ok && !!backup.document,
		...(strict && !strict.ok ? { strictWriteError: strict.reason } : {}),
		models: catalog(registry),
	};
	recordModelRoutingLatency("configLoad", performance.now() - started);
	return snapshot;
}

export async function saveModelRoutingSnapshot(
	configPath: string,
	expectedRevision: string,
	document: unknown,
	options?: { restoreBackup?: boolean },
) {
	const started = performance.now();
	try { return await saveLlmPreferencesDocument(configPath, expectedRevision, document, options); }
	finally { recordModelRoutingLatency("configSave", performance.now() - started); }
}

/** Search all tokens in arbitrary order. Provider words score in their own
 * field, while model and alias text remain independent evidence. */
export function scoreModelRoutingSearch(query: string, model: ModelRoutingCatalogItem, aliases: string[] = [], pins: string[] = []): number {
	const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
	const expand = (text: string) => {
		const result: string[] = [];
		const normalized = text.toLowerCase();
		// Preserve model-family versions as one piece of evidence. Do this on
		// each name/ID separately below so unrelated numbers never combine.
		for (const match of normalized.matchAll(/\b([a-z]{2,})[-_. ]?(\d+(?:[._-]\d+)+)\b/g)) {
			const family = normalize(match[1]!);
			const version = match[2]!.replace(/\D/g, "");
			if (family && version) result.push(`${family}${version}`, family, version);
		}
		for (const match of normalized.matchAll(/(?:^|\D)(\d+(?:[._-]\d+)+)(?=\D|$)/g)) {
			const version = match[1]!.replace(/\D/g, "");
			if (version) result.push(version);
		}
		for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
			if (raw === "h4") { result.push("hermes", "4"); continue; }
			const compact = normalize(raw);
			if (!compact) continue;
			result.push(compact);
			const familyVersion = compact.match(/^([a-z]{2,}?)(\d{2,})$/);
			if (familyVersion) result.push(familyVersion[1]!, familyVersion[2]!);
		}
		return [...new Set(result)];
	};
	const rawTokens = expand(query).slice(0, 16);
	if (!rawTokens.length) return 1;
	const modifiers = new Set(["official", "direct"]);
	const searchTokens = rawTokens.filter(token => !modifiers.has(token));
	const provider = normalize(model.provider);
	const host = normalize(model.providerHost ?? "");
	const modelTokens = [...new Set([model.id, model.name ?? "", ...aliases, model.api ?? ""].flatMap(value => expand(value)))];
	const pinTokens = expand(`${pins.join(" ")} ${JSON.stringify(model.globalProviderRouting ?? {})}`);
	const allProviderNames = new Set([provider, ...providerAliasNames(provider).map(normalize), host].filter(Boolean));
	const official = rawTokens.includes("official") || rawTokens.includes("direct");
	// Every provider named in the query is evidence. Reading only the first one
	// let "openrouter deepseek official" exclude the real DeepSeek route.
	const queryProviders = searchTokens.filter(token => knownProvider(token) || allProviderNames.has(token));
	const exactProvider = queryProviders.some(token => providerMatches(token, model.provider, model.providerHost));
	if (official && queryProviders.length && !exactProvider) return 0;
	let score = 0;
	for (const t of searchTokens) {
		if (!t) continue;
		// A provider-identity match is stronger evidence than a saved pin for
		// the same word: otherwise "together glm flash" ranks an OpenRouter
		// route that merely prefers Together above the real Together route.
		if (providerMatches(t, model.provider, model.providerHost)) { score += 20; continue; }
		// With official/direct, a named provider that does not host this model
		// is a filter rather than a mismatch, because at least one named
		// provider already matched this route above.
		if (official && (knownProvider(t) || allProviderNames.has(t))) continue;
		if (pinTokens.some(word => word === t)) { score += 14; continue; }
		if (pinTokens.some(word => tokenMatches(word, t))) { score += 10; continue; }
		if (modelTokens.some(word => word === t)) { score += 10; continue; }
		if (modelTokens.some(word => tokenMatches(word, t))) { score += 7; continue; }
		if (host.includes(t)) { score += 5; continue; }
		const fuzzy = modelTokens.some(word => editDistanceWithinOne(word, t));
		if (!fuzzy) return 0;
		score += 3;
	}
	// The official bonus belongs to the provider that actually serves the model;
	// an aggregator route is never "official" merely because it was named.
	if (official && exactProvider && !AGGREGATOR_PROVIDERS.has(model.provider.toLowerCase())) score += 18;
	// Catalog routes this session cannot use stay selectable but rank below the
	// routes the resolver can actually accept.
	return model.enabled ? score + 0.25 : score * 0.6;
}

/** Provider words that can refer to OpenRouter upstream endpoints. Returned
 * values are canonical UI hints only; callers still need endpoint metadata
 * before presenting a selectable upstream variant. */
export function modelRoutingProviderHints(query: string): string[] {
	const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
	const tokens = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(normalize);
	const known = ["together", "friendli", "fireworks", "deepinfra", "novita", "nebius", "cerebras", "cloudflare", "google", "anthropic", "openai", "mistral", "groq"];
	return [...new Set(known.filter(provider => {
		const forms = [provider, ...providerAliasNames(provider).map(normalize)];
		return tokens.some(token => forms.some(form => token === form || token.length >= 4 && editDistanceWithinOne(form, token)));
	}))];
}

function tokenMatches(word: string, query: string): boolean {
	return word === query || word.includes(query) || query.includes(word) && word.length >= 3 || editDistanceWithinOne(word, query);
}

/** Providers that resell other providers' models. An "official"/"direct"
 * request never grants them the first-party bonus. */
const AGGREGATOR_PROVIDERS = new Set(["openrouter", "orcarouter"]);

function providerAliasNames(provider: string): string[] {
	const aliases: Record<string, string[]> = {
		openrouter: ["open router", "or"],
		deepseek: ["deep seek"],
		friendli: ["friendli ai"],
		together: ["together ai", "togetherai", "together computer"],
		orcarouter: ["orca router"],
		cerebras: ["cerebras ai"],
		runinfra: ["run infra"],
	};
	return aliases[provider.toLowerCase()] ?? [];
}

function knownProvider(token: string): boolean {
	return ["openrouter", "deepseek", "friendli", "friendliai", "together", "togetherai", "togethercomputer", "orcarouter", "cerebras", "runinfra", "anthropic", "openai", "google", "mistral", "groq", "fireworks", "deepinfra", "novita", "nebius"].includes(token);
}

function providerMatches(token: string, providerName: string, host?: string): boolean {
	const p = providerName.toLowerCase().replace(/[^a-z0-9]+/g, "");
	const aliases = providerAliasNames(p).map(value => value.replace(/[^a-z0-9]+/g, ""));
	const target = token.toLowerCase().replace(/[^a-z0-9]+/g, "");
	if (p === target || aliases.includes(target) || p.startsWith(target) && target.length >= 4) return true;
	if (host && normalizeProviderHost(host).includes(target) && target.length >= 5) return true;
	return editDistanceWithinOne(p, target);
}

function normalizeProviderHost(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }

function editDistanceWithinOne(left: string, right: string): boolean {
	if (Math.abs(left.length - right.length) > 1 || Math.min(left.length, right.length) < 4) return false;
	let i = 0, j = 0, edits = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) { i++; j++; continue; }
		if (++edits > 1) return false;
	if (left.length > right.length) i++;
	else if (right.length > left.length) j++;
	else { i++; j++; }
	}
	return edits + Number(i < left.length || j < right.length) <= 1;
}
