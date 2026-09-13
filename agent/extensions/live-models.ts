import {boundedContextLimit,normalizeModelLimits} from "./lib/context-limits.ts";
import { registerLocalModels } from "./lib/local-models.ts";
import { refreshModelResearch } from "./pi-subagents/src/runs/shared/model-research.ts";
import { toModelInfo } from "./pi-subagents/src/shared/model-info.ts";
/**
 * Live Model Catalog — auto-lists provider models that the native pi.dev
 * catalog does not carry yet.
 *
 * WHY: the native catalog (models-store.json, refreshed from pi.dev) is a
 * curated snapshot. OpenRouter serves 396 models live vs 332 in the store,
 * orcarouter has NO native catalog at all (2 static models was the
 * regression), and together/friendli live lists grow on their own timeline.
 * runinfra is the same story (no pi.dev catalog; its /v1/models catalog is
 * the only source of truth for new models).
 * This extension fetches each provider's live API and merges it over the
 * native store, so new releases appear in /model without editing
 * models.json. It replaces the retired *-auto-models.ts extensions
 * (backups/provider-cleanup-20260831/) with one shared cache.
 *
 * Rules:
 * - Live metadata wins (cost/context/maxTokens/reasoning). Store overlay
 *   contributes only what live APIs cannot express: thinkingLevelMap and
 *   compat (wire formats differ per provider).
 * - Catalog TTL 15m; `pi update --models` (force) bypasses. On failure the
 *   previous list is retained; offline startup serves the cache.
 * - Never persists to models-store.json (the native catalog owns that file).
 * - models.json provider-level `compat` is NOT folded into extension models
 *   by applyExtension, so it is merged here per model explicitly.
 * - OpenRouter live-only models (no pi.dev store entry yet) derive their
 *   thinkingLevelMap from the live `reasoning.supported_efforts` metadata,
 *   so freshly shipped models expose minimal/xhigh (and max where offered)
 *   immediately instead of waiting for the pi.dev store to catch up.
 * - Opt-in together reasoning experiments probe unknown model ids and
 *   cached by id; probes run without blocking catalog publication. Refresh
 *   cancellation stops them; HTTP failures remain unknown, not negative.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { FreeRouteCapabilities } from "./pi-subagents/src/runs/shared/free-route-evidence.ts";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	publishFreeEvidence,
	publishProviderFreeEvidence,
	FREE_CATALOG_URL,
	ORCA_PRICING_URL,
} from "./pi-subagents/src/runs/shared/free-route-evidence.ts";

const AGENT_DIR: string =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const MODELS_JSON = join(AGENT_DIR, "models.json");
const CACHE_FILE = join(AGENT_DIR, "live-model-catalog.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const ROUTER_CATALOG_TTL_MS = 15 * 60 * 1000; // cheaper than stale capability/price guesses
const FETCH_TIMEOUT_MS = 25_000;
const PROBE_CONCURRENCY = 6;
const MODEL_TIMEOUT_MS = 25_000;

/** Wire fallbacks when models.json is unreadable; models.json is canonical. */
const DEFAULT_BASE_URLS: Record<string, string> = {
	openrouter: "https://openrouter.ai/api/v1",
	orcarouter: "https://api.orcarouter.ai/v1",
	together: "https://api.together.xyz/v1",
	friendli: "https://api.friendli.ai/serverless/v1",
	cerebras: "https://api.cerebras.ai/v1",
	deepseek: "https://api.deepseek.com/v1",
	runinfra: "https://api.runinfra.ai/v1",
};

/**
 * api/baseUrl for the composed provider.
 * WHY: applyExtension requires per-model api/baseUrl when the extension
 * registers custom models; without it, providers whose native store entry
 * is empty (orcarouter/friendli have no pi.dev catalog) throw on publish
 * and pi-ai treats the refresh as "no models".
 */
function wireFor(providerId: string): { api: string; baseUrl: string } {
	try {
		const json = JSON.parse(readFileSync(MODELS_JSON, "utf-8")) as {
			providers?: Record<string, { api?: string; baseUrl?: string }>;
		};
		const p = json.providers?.[providerId];
		return {
			api: p?.api ?? "openai-completions",
			baseUrl: p?.baseUrl ?? DEFAULT_BASE_URLS[providerId] ?? "",
		};
	} catch {
		return {
			api: "openai-completions",
			baseUrl: DEFAULT_BASE_URLS[providerId] ?? "",
		};
	}
}

type PiModel = Omit<ProviderModelConfig, "cost"> & { cost: ProviderModelConfig["cost"] & { missing?: string[]; knownFree?: boolean }; outputLimitEstimated?: boolean };
type RefreshModelContext = Parameters<
	NonNullable<ProviderConfig["refreshModels"]>
>[0];

// ── Cache ──────────────────────────────────────────────────────────────

interface CacheEntry {
	ts: number;
	models: PiModel[];
	/** Raw catalog definitions; current provider config is applied only at publication. */
	rawCompat?: true;
	/** together reasoning probes: id -> { r: reasoning, ts } */
	probes?: Record<string, { r: boolean; ts: number }>;
}

interface CacheFile {
	version: 1;
	providers: Record<string, CacheEntry>;
}

let cacheWriteChain: Promise<void> = Promise.resolve();

/** Serialize the existing cache transaction across Pi processes as well. */
async function acquireCacheLock(signal?: AbortSignal): Promise<() => void> {
	const lock = `${CACHE_FILE}.lock`;
	const deadline = Date.now() + 5000;
	for (;;) {
		signal?.throwIfAborted();
		try {
			mkdirSync(lock, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Never remove another writer's lock based on age: two reclaimers can
			// otherwise remove a newly acquired lock. Metadata stays usable in memory
			// if a crashed writer leaves a lock requiring later manual cleanup.
			if (Date.now() >= deadline) throw new Error(`Catalog cache lock timed out: ${lock}; inspect its owner and remove only an abandoned lock`);
			await delay(25, undefined, { signal });
			continue;
		}
		try { writeFileSync(join(lock, "owner"), String(process.pid), { mode: 0o600 }); }
		catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
		return () => rmSync(lock, { recursive: true, force: true });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function tokenLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function modelRows<T extends { id: string }>(value: unknown): T[] {
	if (!Array.isArray(value)) throw new Error("Catalog models must be an array");
	return value.filter(
		(row) =>
			isRecord(row) &&
			typeof row.id === "string" &&
			row.id.trim() &&
			!/[\u0000-\u001f\u007f-\u009f]/u.test(row.id) &&
			[
				"context_length",
				"context_window",
				"max_completion_tokens",
				"max_output_tokens",
			].every((key) => row[key] == null || tokenLimit(row[key])),
	) as T[];
}
function validModels(value: unknown): PiModel[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(m): m is PiModel =>
			isRecord(m) &&
			typeof m.id === "string" &&
			m.id.trim().length > 0 &&
			!/[\u0000-\u001f\u007f-\u009f]/u.test(m.id) &&
			typeof m.name === "string" &&
			typeof m.reasoning === "boolean" &&
			Array.isArray(m.input) &&
			m.input.length > 0 &&
			m.input.every((x) => typeof x === "string") &&
			tokenLimit(m.contextWindow) &&
			tokenLimit(m.maxTokens) &&
			m.maxTokens <= m.contextWindow &&
			isRecord(m.cost) &&
			["input", "output", "cacheRead", "cacheWrite"].every((key) => {
				const cost = (m.cost as Record<string, unknown>)[key];
				return typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
			}),
	);
}
function loadCache(): CacheFile {
	const cache: CacheFile = { version: 1, providers: {} };
	try {
		const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
		if (parsed?.version !== 1 || !isRecord(parsed.providers)) return cache;
		for (const [id, entry] of Object.entries(parsed.providers)) {
			if (!isRecord(entry)) continue;
			const models = validModels(entry.models);
			if (!models.length) continue;
			const ts =
				entry.rawCompat === true &&
				typeof entry.ts === "number" &&
				Number.isFinite(entry.ts) &&
				entry.ts >= 0 &&
				entry.ts <= Date.now()
					? entry.ts
					: 0;
			const probes = isRecord(entry.probes)
				? (Object.fromEntries(
						Object.entries(entry.probes).filter(
							([, p]) =>
								isRecord(p) &&
								typeof p.r === "boolean" &&
								typeof p.ts === "number" &&
								Number.isFinite(p.ts) &&
								p.ts >= 0 &&
								p.ts <= Date.now(),
						),
					) as CacheEntry["probes"])
				: undefined;
			Object.defineProperty(cache.providers, id, {
				value: {
					ts,
					models,
					...(entry.rawCompat === true ? { rawCompat: true } : {}),
					...(probes ? { probes } : {}),
				},
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	} catch {
		// missing/corrupt cache = empty
	}
	return cache;
}

/** Serialized writes: refresh phases for different providers can overlap. */
function saveCache(
	entry: CacheEntry | ((current: CacheEntry | undefined) => CacheEntry | undefined),
	providerId: string,
	signal?: AbortSignal,
): Promise<void> {
	const write = cacheWriteChain.then(async () => {
		if (signal?.aborted) return;
		const release = await acquireCacheLock(signal);
		const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
		try {
			if (signal?.aborted) return;
			const cache = loadCache();
			const current = cache.providers[providerId];
			let next = typeof entry === "function" ? entry(current) : entry;
			if (!next) return;
			// A late refresh cannot replace newer catalog/probe evidence. Timestamp
			// is request-start time, so slow older requests cannot become newest.
			const probes = mergeProbes(current?.probes, next.probes ?? {});
			if (current && current.ts > next.ts) next = current;
			cache.providers[providerId] = { ...next, ...(Object.keys(probes).length ? { probes } : {}) };
			writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
			renameSync(tmp, CACHE_FILE);
		} finally {
			try { rmSync(tmp, { force: true }); } finally { release(); }
		}
	});
	// Report this write's failure to its caller without poisoning later writes.
	cacheWriteChain = write.catch(() => {});
	return write;
}

function mergeProbes(
	existing: Record<string, { r: boolean; ts: number }> | undefined,
	results: Record<string, { r: boolean; ts: number }>,
): Record<string, { r: boolean; ts: number }> {
	const merged = { ...existing };
	for (const [id, result] of Object.entries(results)) {
		if (!merged[id] || result.ts >= merged[id].ts) merged[id] = result;
	}
	return merged;
}

/** Native catalog overlay (pi.dev, models-store.json) keyed by id. */
function storeModels(providerId: string): Map<string, PiModel> {
	try {
		const store = JSON.parse(
			readFileSync(join(AGENT_DIR, "models-store.json"), "utf-8"),
		) as Record<string, { models?: PiModel[] }>;
		const models = validModels(store[providerId]?.models);
		return new Map(models.map((m) => [m.id, m]));
	} catch {
		return new Map();
	}
}

/** models.json provider-level compat (applyExtension does not fold it in). */
function providerJsonCompat(providerId: string): Record<string, unknown> {
	try {
		const json = JSON.parse(
			readFileSync(join(AGENT_DIR, "models.json"), "utf-8"),
		) as { providers?: Record<string, { compat?: Record<string, unknown> }> };
		return json.providers?.[providerId]?.compat ?? {};
	} catch {
		return {};
	}
}

/** Deep-merge the few nested compat keys, mirroring provider-composer. */
function mergeCompat(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base, ...override };
	for (const key of [
		"openRouterRouting",
		"vercelGatewayRouting",
		"chatTemplateKwargs",
		"chatTemplateArgs",
	]) {
		const b = base[key];
		const o = override[key];
		if (
			(typeof b === "object" && b !== null) ||
			(typeof o === "object" && o !== null)
		) {
			merged[key] = { ...(b as object), ...(o as object) };
		}
	}
	return merged;
}

// ── Shared helpers ─────────────────────────────────────────────────────

function toPerMillion(v: string | undefined): number {
	const n = Number(v ?? "0") * 1_000_000;
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

function clampMaxTokens(ctx: number, maxTokens: number): number {
	// Catalog facts are not session budgets. Unknown/invalid facts cannot be cached.
	return tokenLimit(ctx) && tokenLimit(maxTokens)
		? Math.min(ctx, maxTokens)
		: Number.NaN;
}

function modalitiesToInput(mods: string[] | undefined): ("text" | "image")[] {
	return (mods ?? []).some((m) => m === "image" || m === "video")
		? ["text", "image"]
		: ["text"];
}

/**
 * Effort map for live-only OpenRouter models (no pi.dev store entry yet).
 * OpenRouter normalizes unlisted efforts, so low/medium/high always pass
 * through; minimal/xhigh/max are opt-in (non-null map entries) and are only
 * mapped when the model's live metadata (reasoning.supported_efforts)
 * actually advertises them. Without metadata this degrades to the
 * conservative low/medium/high-only map — the shape that surfaced as
 * "muse-spark-1.3 has only three effort options" when the pi.dev store had
 * not picked the model up yet.
 */
function openrouterEffortMap(
	supportedEfforts: string[] | undefined,
    mandatory?: boolean,
): Record<string, string | null> {
	const has = (effort: string) => supportedEfforts?.includes(effort) ?? false;
	return {
		off: mandatory === false || has("none") ? "none" : null,
		minimal: has("minimal") ? "minimal" : null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: has("xhigh") ? "xhigh" : null,
		max: has("max") ? "max" : null,
	};
}

async function fetchJson(
	url: string,
	signal: AbortSignal | undefined,
	init?: RequestInit,
): Promise<unknown> {
	const sig = signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const res = await fetch(url, {
		...init,
		redirect: "error",
		signal: AbortSignal.any([sig, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
	});
	if (!res.ok) throw new Error(`${res.status} ${url}`);
	return res.json();
}

function postJson(
	url: string,
	body: Record<string, unknown>,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
	});
}

// ── OpenRouter ─────────────────────────────────────────────────────────

interface OrLiveModel {
	id: string;
	/** Official API: Unix seconds when added to this catalog, not released. */
	created?: number;
	name: string;
	context_length?: number;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	pricing?: Record<string, string>;
	top_provider?: { context_length?: number; max_completion_tokens?: number };
	supported_parameters?: string[];
	reasoning?: {
		mandatory?: boolean;
		default_enabled?: boolean;
		supported_efforts?: string[];
	};
	expiration_date?: string;
	deprecation?: { deprecation_date?: string };
}

/** Catalog-derived capability facts for the free-route evidence row. */
function catalogAddedAt(created: unknown): { catalogAddedAt?: number } {
	return typeof created === "number" && Number.isSafeInteger(created) && created > 0 && created * 1000 <= Date.now()
		? { catalogAddedAt: created * 1000 } : {};
}

function openRouterCapabilities(m: OrLiveModel): FreeRouteCapabilities {
	const params = m.supported_parameters ?? [];
	return {
		...catalogAddedAt(m.created),
		...(typeof m.top_provider?.context_length === "number" ||
		typeof m.context_length === "number"
			? { contextWindow: boundedContextLimit(m.top_provider?.context_length, m.context_length) }
			: {}),
		...(typeof m.top_provider?.max_completion_tokens === "number"
			? { maxTokens: m.top_provider.max_completion_tokens }
			: {}),
		...(m.architecture?.input_modalities?.length
			? { inputModalities: [...m.architecture.input_modalities] }
			: {}),
		...(params.includes("tools") ? { toolCalling: true } : {}),
		...(params.includes("response_format") ||
		params.includes("structured_outputs")
			? { structuredOutput: true }
			: {}),
		...(params.includes("reasoning") ||
		m.reasoning?.mandatory === true ||
		m.reasoning?.default_enabled === true
			? { reasoning: true }
			: {}),
	};
}

function mapOpenRouterModel(m: OrLiveModel): PiModel {
	const params = m.supported_parameters ?? [];
	const reasoning =
		params.includes("reasoning") ||
		(m.reasoning?.mandatory ?? false) ||
		(m.reasoning?.default_enabled ?? false);
	const ctx = boundedContextLimit(m.top_provider?.context_length, m.context_length) ?? 128_000;
	const maxTokens = clampMaxTokens(
		ctx,
		m.top_provider?.max_completion_tokens ?? Math.min(131_072, ctx),
	);
	return {
		id: m.id,
		name: m.name ?? m.id,
		api: "openai-completions",
		reasoning,
        thinkingLevelMap: openrouterEffortMap(m.reasoning?.supported_efforts, m.reasoning?.mandatory),
		input: modalitiesToInput(m.architecture?.input_modalities),
		contextWindow: ctx,
		maxTokens,
		cost: {
			input: toPerMillion(m.pricing?.prompt),
			output: toPerMillion(m.pricing?.completion),
			missing: ['input','output'].filter((_,i) => {const value=m.pricing?.[i===0?'prompt':'completion'];return value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) || Number(value)<0;}),
			knownFree: ['prompt','completion'].every(key=>m.pricing?.[key] !== undefined && m.pricing[key] !== null && m.pricing[key] !== '' && Number(m.pricing[key]) === 0),
			cacheRead: toPerMillion(m.pricing?.input_cache_read ?? m.pricing?.prompt),
			cacheWrite: toPerMillion(m.pricing?.input_cache_write ?? m.pricing?.prompt),
		},
	};
}

async function fetchOpenRouterLive(context: RefreshModelContext): Promise<{
	models: PiModel[];
	effortsById: Map<string, string[] | undefined>;
}> {
	const raw = (await fetchJson(
		"https://openrouter.ai/api/v1/models",
		context.signal,
		{
			headers: { Authorization: `Bearer ${resolvedCatalogApiKey("openrouter", context) ?? ""}` },
		},
	)) as { data?: OrLiveModel[] };
	const now = Date.now();
	const models = modelRows<OrLiveModel>(raw.data).filter((m) => {
		if (m.expiration_date && Date.parse(m.expiration_date) <= now) return false;
		if (
			m.deprecation?.deprecation_date &&
			Date.parse(m.deprecation.deprecation_date) <= now
		) {
			return false;
		}
		const out = m.architecture?.output_modalities;
		if (out && !out.includes("text")) return false;
		return true;
	});
	const effortsById = new Map<string, string[] | undefined>(
		models.map((m) => [m.id, m.reasoning?.supported_efforts]),
	);
	// Free-route evidence rows carry the raw pricing plus catalog capability
	// facts, so consumers can match requirements without guessing from names.
	publishFreeEvidence(
		models.map((m) => ({
			id: m.id,
			pricing: m.pricing ?? {},
			capabilities: openRouterCapabilities(m),
		})),
		FREE_CATALOG_URL,
		now,
	);
	return { models: models.map(mapOpenRouterModel), effortsById };
}

async function refreshOpenRouter(
	context: RefreshModelContext,
): Promise<PiModel[]> {
	const { models: live, effortsById } = await fetchOpenRouterLive(context);
	const store = storeModels("openrouter");
	const projected = live.map((m) => {
		const fromStore = store.get(m.id);
		if (!fromStore) {
			// Live-only model: derive the effort map from OpenRouter's live
			// reasoning metadata (see openrouterEffortMap) instead of a fixed
			// low/medium/high-only default.
			return {
				...m,
				thinkingLevelMap: m.thinkingLevelMap ?? openrouterEffortMap(effortsById.get(m.id)),
				compat: { thinkingFormat: "openrouter" },
			};
		}
		return {
			...m,
			thinkingLevelMap: fromStore.thinkingLevelMap,
			compat: mergeCompat(
				{ thinkingFormat: "openrouter" },
				fromStore.compat ?? {},
			),
		};
	});
	// Store-only entries (pi.dev aliases like ~anthropic/claude-sonnet-latest)
	// stay as-is: live never lists them.
	const keepStoreOnly = [...store.values()].filter(
		(m) => !live.some((x) => x.id === m.id),
	);
	return [...projected, ...keepStoreOnly];
}

// ── OrcaRouter ─────────────────────────────────────────────────────────

interface OrcaLiveModel {
	id: string;
	name?: string;
	context_length?: number;
	max_completion_tokens?: number;
	architecture?: { input_modalities?: string[] };
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
		prompt_per_million?: string;
		completion_per_million?: string;
	};
}

interface OrcaCatalogEntry {
	model_name: string;
	display_name?: string;
	quota_type?: number;
	model_ratio?: number;
	completion_ratio?: number;
	cache_ratio?: number;
	context_length?: number;
	max_completion_tokens?: number;
	input_modalities?: string[];
	supported_parameters?: string[];
	/** Authoritative zero-cost flags from OrcaRouter's own pricing catalog. */
	is_free_tier?: boolean;
	model_price?: number;
	free_base_model?: string;
}

const ORCA_FALLBACK_KEY = process.env.ORCAROUTER_API_KEY ?? "";

const ORCA_FALLBACK_MODELS: PiModel[] = [
	{
		id: "orcarouter/auto",
		name: "OrcaRouter Auto",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			thinkingFormat: "openrouter",
			supportsDeveloperRole: false,
			sendSessionAffinityHeaders: true,
		},
	},
	{
		id: "orcarouter/fusion",
		name: "OrcaRouter Fusion",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			thinkingFormat: "openrouter",
			supportsDeveloperRole: false,
			sendSessionAffinityHeaders: true,
		},
	},
];

function orcaCompat(reasoning: boolean): Record<string, unknown> {
	return {
		sendSessionAffinityHeaders: true,
		thinkingFormat: "openrouter",
		supportsDeveloperRole: false,
		...(reasoning ? { supportsReasoningEffort: true } : {}),
	};
}

function orcaThinkingLevels(): Record<string, string | null> {
	return {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	};
}

/**
 * Publish OrcaRouter free-route evidence. Proof = OrcaRouter's own pricing
 * catalog (authoritative): is_free_tier === true with zero model/completion
 * ratios and zero per-request price — corroborated by the ratio math that
 * drives mapOrcaModel's cost. Rows are limited to models the live /v1/models
 * list actually serves (catalog presence alone is not a route). Names are
 * never proof: router models (orcarouter/free, orcarouter/auto, …) have no
 * pricing entry and are therefore NOT published.
 */
function publishOrcaFreeEvidence(
	live: OrcaLiveModel[],
	catalogById: Map<string, OrcaCatalogEntry>,
	authoritativePricing = true,
): void {
	if (!authoritativePricing) return; // Failed fetch may retain bounded prior evidence.
	const rows = live.flatMap((m) => {
		const c = catalogById.get(m.id);
		if (!c) return [];
		if (c.is_free_tier !== true) return [];
		// An exact live charge contradicts an older free-tier catalog row.
		// Never keep calling such a route free merely because its name/flag says so.
		if (m.pricing && Object.values(m.pricing).some(value =>
			!(typeof value === "number" && value === 0 || typeof value === "string" && /^0+(?:\.0+)?$/.test(value)))) return [];
		if (
			(c.model_ratio ?? 1) !== 0 ||
			(c.completion_ratio ?? 1) !== 0 ||
			(c.model_price ?? 0) !== 0
		)
			return [];
		const params = c.supported_parameters ?? [];
		return [
			{
				provider: "orcarouter",
				id: m.id,
				pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				capabilities: {
					...(typeof c.context_length === "number" ||
					typeof m.context_length === "number"
						? { contextWindow: c.context_length ?? m.context_length }
						: {}),
					...(typeof c.max_completion_tokens === "number" ||
					typeof m.max_completion_tokens === "number"
						? { maxTokens: c.max_completion_tokens ?? m.max_completion_tokens }
						: {}),
					...(c.input_modalities?.length
						? { inputModalities: [...c.input_modalities] }
						: {}),
					...(params.includes("tools") ? { toolCalling: true } : {}),
					...(params.includes("response_format") ||
					params.includes("structured_outputs")
						? { structuredOutput: true }
						: {}),
					...(params.includes("reasoning") ? { reasoning: true } : {}),
				} satisfies FreeRouteCapabilities,
			},
		];
	});
	// A successful authoritative empty/repriced catalog revokes old free evidence.
	publishProviderFreeEvidence("orcarouter", rows, ORCA_PRICING_URL, Date.now());
}

function mapOrcaModel(
	live: OrcaLiveModel,
	catalog: OrcaCatalogEntry | undefined,
	groupRatio: number,
): PiModel {
	const ctx = live.context_length ?? catalog?.context_length ?? 200_000;
	const maxTokens = clampMaxTokens(
		ctx,
		live.max_completion_tokens ??
			catalog?.max_completion_tokens ??
			Math.min(8192, ctx),
	);
	const params = catalog?.supported_parameters ?? [];
	const reasoning = params.includes("reasoning");
	const input = modalitiesToInput(
		live.architecture?.input_modalities ?? catalog?.input_modalities,
	);
	// Live pricing is exact $/1M; fall back to ratio math verified against
	// the console: input = model_ratio * 2 * group ratio.
	const perM = (perMillion: string | undefined, perToken: string | undefined) =>
		perMillion !== undefined && perMillion !== ""
			? parseFloat(perMillion)
			: perToken !== undefined && perToken !== ""
				? parseFloat(perToken) * 1_000_000
				: 0;
	let cost: PiModel["cost"];
	if (live.pricing?.prompt_per_million !== undefined || live.pricing?.prompt !== undefined) {
		cost = {
			input: perM(live.pricing.prompt_per_million, live.pricing.prompt),
			output: perM(live.pricing.completion_per_million, live.pricing.completion),
			missing: live.pricing.completion_per_million === undefined && live.pricing.completion === undefined ? ['output'] : [],
			cacheRead: live.pricing.input_cache_read !== undefined ? toPerMillion(live.pricing.input_cache_read) : perM(live.pricing.prompt_per_million, live.pricing.prompt) * (catalog?.cache_ratio ?? 1),
			cacheWrite: live.pricing.input_cache_write !== undefined ? toPerMillion(live.pricing.input_cache_write) : perM(live.pricing.prompt_per_million, live.pricing.prompt),
		};
	} else {
		const inputCost = (catalog?.model_ratio ?? 0) * 2 * groupRatio;
		cost = {
			input: inputCost,
			missing: catalog?.model_ratio === undefined ? ['input','output','cacheRead'] : [],
			output: inputCost * (catalog?.completion_ratio ?? 1),
			cacheRead: inputCost * (catalog?.cache_ratio ?? 1),
			cacheWrite: 0,
		};
	}
	return {
		id: live.id,
		name: live.name ?? catalog?.display_name ?? live.id,
		api: "openai-completions",
		reasoning,
		input,
		contextWindow: ctx,
		maxTokens,
		cost,
		...(reasoning
			? {
					thinkingLevelMap: orcaThinkingLevels(),
					compat: orcaCompat(true),
				}
			: { compat: orcaCompat(false) }),
	};
}

async function refreshOrcaRouter(
	context: RefreshModelContext,
): Promise<PiModel[]> {
	const key = resolvedCatalogApiKey("orcarouter", context) || ORCA_FALLBACK_KEY;
	const raw = (await fetchJson(
		"https://api.orcarouter.ai/v1/models",
		context.signal,
		{ headers: { Authorization: `Bearer ${key}` } },
	)) as { data?: OrcaLiveModel[] };
	const live = modelRows<OrcaLiveModel>(raw.data);
	if (live.length === 0) {
		throw new Error("orcarouter live catalog is empty or invalid");
	}
	// Public pricing catalog: reasoning flags, ratios, display names.
	let catalogById = new Map<string, OrcaCatalogEntry>();
	let groupRatio = 1;
	let authoritativePricing = false;
	try {
		const pricing = (await fetchJson(
			"https://www.orcarouter.ai/api/pricing",
			context.signal,
		)) as {
			data?: OrcaCatalogEntry[];
			effective_group_ratio?: number;
		};
		if (!Array.isArray(pricing.data)) throw new Error("Orca pricing catalog has no data array");
		catalogById = new Map(pricing.data.map((e) => [e.model_name, e]));
		authoritativePricing = true;
		groupRatio = pricing.effective_group_ratio ?? 1;
	} catch {
		// catalog is enrichment; live list alone remains valid
	}
	publishOrcaFreeEvidence(live, catalogById, authoritativePricing);
	return live.map((m) => mapOrcaModel(m, catalogById.get(m.id), groupRatio));
}

// ── Together ───────────────────────────────────────────────────────────

interface TogetherLiveModel {
	id: string;
	type?: string;
	display_name?: string;
	context_length?: number;
	max_completion_tokens?: number;
	pricing?: { input?: number; output?: number; cached_input?: number };
}

function togetherEffortMap(
	supportsMax: boolean,
): Record<string, string | null> {
	return {
		off: null,
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "high",
		max: supportsMax ? "max" : "high",
	};
}

/** One tiny completion; reasoning_content presence is the capability signal. */
async function probeTogether(
	id: string,
	apiKey: string,
	signal: AbortSignal,
): Promise<boolean> {
	const res = await postJson(
		"https://api.together.xyz/v1/chat/completions",
		{
			model: id,
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 16,
			reasoning: { enabled: true },
			reasoning_effort: "medium",
		},
		{ Authorization: `Bearer ${apiKey}` },
		signal,
	);
	if (!res.ok) throw new Error(`Together reasoning probe HTTP ${res.status}`);
	const data = (await res.json()) as {
		choices?: { message?: { content?: string; reasoning_content?: string } }[];
	};
	const message = data?.choices?.[0]?.message;
	if (!message || (typeof message.content !== "string" && typeof message.reasoning_content !== "string"))
		throw new Error("Together reasoning probe returned no usable message");
	return typeof message.reasoning_content === "string" && message.reasoning_content.length > 0;
}

/**
 * Fire-and-forget probes for never-probed ids. Concurrency-bounded; per-id
 * results merge into the cache (a partial probe pass must never clobber a
 * good earlier cache — a 429 storm once did).
 */
function scheduleTogetherProbes(
	ids: string[],
	apiKey: string,
	probes: Record<string, { r: boolean; ts: number }>,
	signal: AbortSignal,
): void {
	// Capability experiments can bill tokens; normal catalog refresh must never infer.
	if (process.env.PI_MODEL_CAPABILITY_PROBES !== "1" || signal.aborted) return;
	const pending = [...new Set(ids)]
		.filter((id) => !probes[id] || Date.now() - probes[id].ts >= CACHE_TTL_MS)
		.slice(0, PROBE_CONCURRENCY);
	if (pending.length === 0) return;
	void (async () => {
		const results: Record<string, { r: boolean; ts: number }> = {};
		let cursor = 0;
		const worker = async () => {
			while (!signal.aborted) {
				const i = cursor++;
				if (i >= pending.length) return;
				const id = pending[i];
				try {
					const r = await probeTogether(id, apiKey, signal);
					if (!signal.aborted) results[id] = { r, ts: Date.now() };
				} catch {
					// probe failure only means "unknown for now" — no entry
				}
			}
		};
		await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, () => worker()));
		if (!signal.aborted && Object.keys(results).length > 0) {
			// Merge at commit time: a late probe may enrich, never replace, a newer catalog.
			await saveCache(
				(entry) => entry ? { ...entry, probes: mergeProbes(entry.probes, results) } : undefined,
				"together",
				signal,
			);
		}
	})().catch(() => {
		console.error(
			"[live-models] Together probe cache write failed; results remain unknown",
		);
	});
}

async function refreshTogether(
	context: RefreshModelContext,
	_cached: CacheEntry | undefined,
): Promise<PiModel[]> {
	const key = resolvedCatalogApiKey("together", context) ?? "";
	const raw = await fetchJson(
		"https://api.together.xyz/v1/models",
		context.signal,
		{ headers: { Authorization: `Bearer ${key}` } },
	);
	const live = modelRows<TogetherLiveModel>(raw).filter(
		(m) => (m.type ?? "chat") === "chat",
	);
	const store = storeModels("together");
	const models = live.map((m) => {
		const fromStore = store.get(m.id);
		const ctx = m.context_length ?? 131_072;
		const reasoning = fromStore?.reasoning ?? false;
		const base: PiModel = {
			id: m.id,
			name: m.display_name ?? fromStore?.name ?? m.id,
			api: "openai-completions",
			reasoning,
			input: fromStore?.input ?? ["text"],
			contextWindow: ctx,
			maxTokens: clampMaxTokens(
				ctx,
				m.max_completion_tokens ?? fromStore?.maxTokens ?? 8192,
			),
			cost: {
				input: m.pricing?.input ?? fromStore?.cost?.input ?? 0,
				output: m.pricing?.output ?? fromStore?.cost?.output ?? 0,
				missing: ['input','output'].filter(key => !Number.isFinite(m.pricing?.[key] ?? fromStore?.cost?.[key])),
				cacheRead: m.pricing?.cached_input ?? (m.pricing?.input !== undefined ? m.pricing.input : fromStore?.cost?.cacheRead ?? fromStore?.cost?.input ?? 0),
				cacheWrite: 0,
			},
		};
		if (m.max_completion_tokens === undefined && !fromStore?.maxTokens)
			base.outputLimitEstimated = true;
		else base.outputLimitEstimated = false;
		if (fromStore) {
			return {
				...base,
				...(fromStore.thinkingLevelMap
					? { thinkingLevelMap: fromStore.thinkingLevelMap }
					: {}),
				compat: fromStore.compat ?? { thinkingFormat: "together" },
			};
		}
		return { ...base, compat: { thinkingFormat: "together" } };
	});
	return models;
}

// ── Friendli ───────────────────────────────────────────────────────────

interface FriendliLiveModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	context_length?: number;
	max_completion_tokens?: number;
	input_modalities?: string[];
	pricing?: {
		input?: string;
		output?: string;
		input_cache_read?: string;
	};
	deprecation_date?: string;
	reasoning_options?: Array<{ type?: string }>;
}

/** GLM effort models: top-level reasoning_effort, enum low|high|max only. */
const GLM_EFFORT_LEVELS: Record<string, string | null> = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: "max",
	max: "max",
};

function friendliThinkingWiring(id: string): Partial<PiModel> {
	if (id === "zai-org/GLM-5.3-Flash" || id === "zai-org/GLM-5.3") {
		return {
			compat: { thinkingFormat: "openai", supportsReasoningEffort: true },
			thinkingLevelMap: GLM_EFFORT_LEVELS,
		};
	}
	if (id === "zai-org/GLM-5.2") {
		// On/off via enable_thinking; effort enum high|max only (user-spec).
		return { compat: { thinkingFormat: "qwen-chat-template" } };
	}
	if (id === "deepseek-ai/DeepSeek-V3.2") {
		return {
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: {
					thinking: { $var: "thinking.enabled", omitWhenOff: true },
				},
			},
		};
	}
	// Missing a compat flag does not disable the SDK's default reasoning_effort.
	return { compat: { supportsReasoningEffort: false } };
}

function mapFriendliModel(m: FriendliLiveModel): PiModel | undefined {
	if (m.deprecation_date && Date.parse(m.deprecation_date) <= Date.now()) {
		return undefined;
	}
	const ctx = m.context_length ?? 128_000;
	return {
		id: m.id,
		name: m.name ?? m.id,
		api: "openai-completions",
		reasoning: m.reasoning === true,
		input: modalitiesToInput(m.input_modalities),
		contextWindow: ctx,
		maxTokens: clampMaxTokens(ctx, m.max_completion_tokens ?? 8192),
		cost: {
			input: toPerMillion(m.pricing?.input),
			output: toPerMillion(m.pricing?.output),
			missing: ['input','output'].filter(key => {const value=m.pricing?.[key];return value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) || Number(value)<0;}),
			cacheRead: toPerMillion(m.pricing?.input_cache_read ?? m.pricing?.input),
			cacheWrite: 0,
		},
		...friendliThinkingWiring(m.id),
	};
}

async function refreshFriendli(
	context: RefreshModelContext,
): Promise<PiModel[]> {
	const raw = (await fetchJson(
		"https://api.friendli.ai/serverless/v1/models",
		context.signal,
		{
			headers: {
				Authorization: `Bearer ${resolvedCatalogApiKey("friendli", context) ?? ""}`,
			},
		},
	)) as { data?: FriendliLiveModel[] };
	return modelRows<FriendliLiveModel>(raw.data)
		.map(mapFriendliModel)
		.filter((m): m is PiModel => m !== undefined);
}

// ── RunInfra ──────────────────────────────────────────────────────────

interface RunInfraLiveModel {
	id: string;
	availability?: string;
	modality?: string;
	context_window?: number;
	context_length?: number;
	max_output_tokens?: number;
	pricing?: { input?: number; output?: number };
	cached_input_price_usd_per_mtok?: number;
	cached_input_price?: number;
}

/**
 * WHY: /v1/models does not expose input modalities (every entry is just
 * "llm"), but runinfra.ai/models advertises image input for these ids
 * (checked 2026-08-31). New/unknown ids degrade to text-only — never
 * blocked, just no image routing until they land here. Drop this set once
 * the catalog carries a real input-modality field.
 */
const RUNINFRA_IMAGE_INPUT_IDS = new Set([
	"glm-5-3-flash",
	"qwen3-8-flash-next",
	"ornith-1-5-35b",
	"qwen3-8-27b",
]);

/**
 * WHY: reasoning is always-on fleet-wide — reasoning_effort accepts
 * minimal/low/medium/high/max (probed 2026-08-31) but rejects "off", and
 * even the smallest models return reasoning_content. "off" maps to null so
 * pi hides the level and omits the param entirely (also probed OK);
 * xhigh/max ride the accepted "max" enum. Efforts are wire-verified, no
 * probes needed per model id.
 */
function runinfraThinkingLevels(): Record<string, string | null> {
	return {
		off: null,
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "max",
		max: "max",
	};
}

function mapRunInfraModel(m: RunInfraLiveModel): PiModel | undefined {
	if (m.availability && m.availability !== "available") return undefined;
	const modality = m.modality ?? "llm";
	// Chat models only: keep llm/vlm/chat, skip embeddings/rerank/audio.
	if (!/llm|vlm|chat/.test(modality)) return undefined;
	const ctx = m.context_window ?? m.context_length ?? 131_072;
	return {
		id: m.id,
		name: m.id,
		api: "openai-completions",
		reasoning: true,
		input: RUNINFRA_IMAGE_INPUT_IDS.has(m.id) ? ["text", "image"] : ["text"],
		contextWindow: ctx,
		maxTokens: clampMaxTokens(ctx, m.max_output_tokens ?? Math.min(131_072, ctx)),
		cost: {
			input: m.pricing?.input ?? 0,
			output: m.pricing?.output ?? 0,
			missing: ['input','output'].filter(key => !Number.isFinite(m.pricing?.[key]) || m.pricing[key]<0),
			cacheRead: m.cached_input_price_usd_per_mtok ?? m.cached_input_price ?? m.pricing?.input ?? 0,
			cacheWrite: 0,
		},
		thinkingLevelMap: runinfraThinkingLevels(),
		// models.json provider-level compat (max_tokens field, no developer
		// role, reasoning_content echo, session-affinity headers).
		compat: {},
	};
}

async function refreshRunInfra(
	context: RefreshModelContext,
): Promise<PiModel[]> {
	// WHY: stored auth.json credential first — resolveConfigValueOrThrow makes
	// a models.json "$VAR" key THROW when the env var is missing (old shells,
	// IDE/systemd launches), which is what surfaced as "Could not refresh
	// runinfra" in the model picker. pi-ai already resolved the effective
	// credential for us; only fall back to models.json/env when absent.
	const key = resolvedCatalogApiKey("runinfra", context);
	const raw = (await fetchJson(
		"https://api.runinfra.ai/v1/models",
		context.signal,
		key ? { headers: { Authorization: `Bearer ${key}` } } : undefined,
	)) as { data?: RunInfraLiveModel[] };
	return modelRows<RunInfraLiveModel>(raw.data)
		.map(mapRunInfraModel)
		.filter((m): m is PiModel => m !== undefined);
}

// ── Id-only catalogs (cerebras, deepseek) ─────────────────────────────

/** models.json provider entry (wire + statics + overrides). */
function providerConfigJson(providerId: string):
	| {
			baseUrl?: string;
			api?: string;
			apiKey?: string;
			models?: PiModel[];
			modelOverrides?: Record<string, Partial<PiModel>>;
	  }
	| undefined {
	try {
		const json = JSON.parse(readFileSync(MODELS_JSON, "utf-8")) as {
			providers?: Record<
				string,
				{
					baseUrl?: string;
					api?: string;
					apiKey?: string;
					models?: PiModel[];
					modelOverrides?: Record<string, Partial<PiModel>>;
				}
			>;
		};
		return json.providers?.[providerId];
	} catch {
		return undefined;
	}
}

/** Bearer key for authenticated catalog fetches: models.json "$VAR" first,
 * then the conventional env names ($ORCA_KEY-style). */
function catalogApiKey(providerId: string): string | undefined {
	const raw = providerConfigJson(providerId)?.apiKey;
	if (typeof raw === "string" && raw.startsWith("$")) {
		return process.env[raw.slice(1)] ?? undefined;
	}
	if (typeof raw === "string" && raw.length > 0) return raw;
	const upper = providerId.toUpperCase();
	return process.env[`${upper}_API_KEY`] ?? process.env[`${upper}_KEY`];
}

/** The native runtime owns credential resolution (including auth.json and login). */
function resolvedCatalogApiKey(
	providerId: string,
	context: RefreshModelContext,
): string | undefined {
	// Catalog adapters target the canonical endpoint. A key configured for a
	// proxy must not travel to a different origin during catalog discovery.
	try {
		if (new URL(wireFor(providerId).baseUrl).origin !== new URL(DEFAULT_BASE_URLS[providerId]).origin)
			return undefined;
	} catch {
		return undefined;
	}
	return (context.credential?.type === "api_key" ? context.credential.key : undefined)
		|| catalogApiKey(providerId)
		|| (providerId === "orcarouter" ? process.env.ORCA_KEY : undefined);
}

// Catalog-wide uncertainty is metadata, not a terminal warning per model.
// Keep the fallback honest without writing into the running TUI's stderr.
const outputFallbacks = new Map<string, number>();
function outputLimitStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const model = ctx.model;
	const fallback = model && ((model as typeof model & { piUnlistedModel?: boolean }).piUnlistedModel ? model.maxTokens : outputFallbacks.get(`${model.provider}/${model.id}`));
	const explicit = model && providerConfigJson(model.provider);
	const configured = explicit?.modelOverrides?.[model.id]?.maxTokens ?? (Array.isArray(explicit?.models) ? explicit.models.find((m) => m.id === model.id)?.maxTokens : undefined);
	ctx.ui.setStatus("model-output-limit", fallback && !tokenLimit(configured)
		? `Output limit unverified: ${model.maxTokens} tokens (fallback); set models.json modelOverrides.maxTokens if known.`
		: undefined);
}
function minimalModel(
	id: string,
	provider: string,
	maxTokens?: number,
): PiModel {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		contextWindow: 131_072,
		maxTokens: maxTokens ?? 8_192,
		outputLimitEstimated: maxTokens === undefined,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/**
 * Refresh a provider whose catalog endpoint returns id-only entries
 * (cerebras /v1/models, deepseek /models). Facts come from the pi.dev
 * store overlay, else conservative defaults — so newly shipped model ids
 * appear automatically without touching models.json.
 */
/** Verified facts for id-only providers whose catalog endpoints expose ids
 * only, so per-model metadata (maxTokens etc.) must come from the pi.dev
 * store or an explicit probe. Add entries with probe evidence in the comment.
 */
type IdOnlyFacts = Partial<
	Pick<PiModel, "name" | "contextWindow" | "maxTokens" | "reasoning" | "input" | "thinkingLevelMap" | "compat">
>;

async function refreshIdOnlyCatalog(
	providerId: string,
	url: string,
	context: RefreshModelContext,
	facts: Record<string, IdOnlyFacts> = {},
): Promise<PiModel[]> {
	const key = resolvedCatalogApiKey(providerId, context);
	const raw = (await fetchJson(url, context.signal, {
		headers: key ? { Authorization: `Bearer ${key}` } : undefined,
	})) as { data?: { id: string }[] };
	const liveIds = modelRows<{ id: string }>(raw.data).map((m) => m.id);
	const store = storeModels(providerId);
	const ids = [...new Set([...liveIds, ...store.keys(), ...Object.keys(facts)])];
	return ids.map((id) => {
		const stored = store.get(id);
		if (stored) return stored;
		const f = facts[id];
		const config = providerConfigJson(providerId);
		const override =
			config?.modelOverrides?.[id]?.maxTokens ??
			config?.models?.find((m) => m.id === id)?.maxTokens;
		return { ...minimalModel(id, providerId, override ?? f?.maxTokens), ...f };
	});
}

// Direct API only: https://api-docs.deepseek.com/quick_start/pricing/ (2026-09-10).
// Peak rates are conservative routing estimates; usage applies the UTC schedule.
function deepseekPeakCost(id: string): PiModel["cost"] | undefined {
    if (id === "deepseek-v4-pro") return Date.now() >= Date.parse("2026-09-14T04:00:00Z")
        ? { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }
        : { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 };
    if (["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(id))
        return { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
}
const DEEPSEEK_FLASH_FACTS: IdOnlyFacts = {
    name: "DeepSeek V4.1 Flash", contextWindow: 1_000_000, maxTokens: 384_000,
    reasoning: true, input: ["text", "image"],
    thinkingLevelMap: {off: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max"},
    compat: {thinkingFormat: "deepseek", supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true, maxTokensField: "max_tokens"},
};

async function refreshCerebras(context: RefreshModelContext): Promise<PiModel[]> {
    // Default public format has actual prices; /v1/models can be ID-only.
    try {
        const raw = await fetchJson("https://api.cerebras.ai/public/v1/models", context.signal);
        const store = storeModels("cerebras");
        const rows = modelRows<any>((raw as any)?.data);
        const models = rows.map((m) => {
            const base = store.get(m.id) ?? minimalModel(m.id, "cerebras");
            const p = m.pricing;
            if (!p) return base;
            const input = p.prompt !== undefined ? toPerMillion(p.prompt) : p.input;
            const output = p.completion !== undefined ? toPerMillion(p.completion) : p.output;
            if (![input, output].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) return base;
            return { ...base, cost: { input, output,
                cacheRead: p.input_cache_read !== undefined ? toPerMillion(p.input_cache_read) : input,
                cacheWrite: p.input_cache_write !== undefined ? toPerMillion(p.input_cache_write) : input } };
        });
        if (models.length) return models;
    } catch { if (context.signal.aborted) return []; }
    return refreshIdOnlyCatalog("cerebras", "https://api.cerebras.ai/v1/models", context, ID_ONLY_FACTS.cerebras);
}

// ── Refresh dispatcher ─────────────────────────────────────────────────

/** Provider ids this extension owns (session_start background refresh scope). */
const REFRESHER_IDS = [
	"openrouter",
	"orcarouter",
	"together",
	"friendli",
	"cerebras",
	"deepseek",
	"runinfra",
] as const;

type Fetcher = (
	context: RefreshModelContext,
	cached: CacheEntry | undefined,
) => Promise<PiModel[]>;

// Id-only provider facts: supplied live probes, 2026-09-06. Unknown ids still
// use an explicitly warned conservative fallback, never guessed capabilities.
const ID_ONLY_FACTS: Record<string, Record<string, IdOnlyFacts>> = {
	cerebras: {
		"qwen-3.8-27b": { maxTokens: 65_536 },
		"qwen3-coder": { maxTokens: 65_536 },
		"gpt-oss-120b": { maxTokens: 32_768 },
	},
	deepseek: Object.fromEntries(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].map(id => [id, DEEPSEEK_FLASH_FACTS])),
};
const PROVIDER_COMPAT: Record<string, Record<string, unknown>> = {
	// Applies to fresh and cached catalogs; explicit model/provider overrides win.
	openrouter: { sendSessionAffinityHeaders: true },
	// Cerebras rejects max_completion_tokens, including on proxy base URLs.
	cerebras: { maxTokensField: "max_tokens" },
};
function publishModels(
	provider: string,
	models: PiModel[],
	probes?: CacheEntry["probes"],
): PiModel[] {
	const idOnly = Object.hasOwn(ID_ONLY_FACTS, provider);
    const officialDeepSeek = provider === "deepseek" && ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(wireFor(provider).baseUrl.replace(/\/$/, ""));
    // Publish the documented canonical ID even when an old cache predates release.
    if (officialDeepSeek && !models.some(m => m.id === "deepseek-flash"))
        models = [...models, {...minimalModel("deepseek-flash", provider, 384_000), ...DEEPSEEK_FLASH_FACTS}];
	const store = idOnly || provider === "together" ? storeModels(provider) : undefined;
	const config = providerConfigJson(provider);
	const configuredCompat = providerJsonCompat(provider);
	for (const key of outputFallbacks.keys()) if (key.startsWith(`${provider}/`)) outputFallbacks.delete(key);
	return validModels(models).map((cachedModel) => {
		const { outputLimitEstimated, ...rawModel } = cachedModel;
		// Probe results arrive after catalog persistence. Project them here so the
		// next cached/offline refresh can use them without another network request.
		const probe = probes?.[rawModel.id];
		const model = provider === "together" && !store?.has(rawModel.id) && !rawModel.reasoning && probe &&
			Date.now() - probe.ts < CACHE_TTL_MS
			? {
				...rawModel,
				reasoning: probe.r,
				thinkingLevelMap: probe.r ? togetherEffortMap(rawModel.id === "moonshotai/Kimi-K3") : undefined,
				compat: mergeCompat(rawModel.compat ?? {}, {
					thinkingFormat: "together",
					supportsReasoningEffort: probe.r,
				}),
			}
			: rawModel;
		const facts =
			idOnly && (provider !== "deepseek" || ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(wireFor(provider).baseUrl.replace(/\/$/, ""))) && Object.hasOwn(ID_ONLY_FACTS[provider], model.id)
				? ID_ONLY_FACTS[provider][model.id]
				: undefined;
		const explicit =
			config?.modelOverrides?.[model.id]?.maxTokens ??
			(Array.isArray(config?.models)
				? config.models.find((m) => m.id === model.id)?.maxTokens
				: undefined);
		if (
			(outputLimitEstimated === true || outputLimitEstimated === undefined && (idOnly || provider === "together" && model.maxTokens === 8192)) &&
			!facts?.maxTokens &&
			!store?.get(model.id)?.maxTokens &&
			!tokenLimit(explicit)
		)
			outputFallbacks.set(`${provider}/${model.id}`, model.maxTokens);
		const defaults =
			provider === "friendli"
				? (friendliThinkingWiring(model.id).compat ?? {})
				: (PROVIDER_COMPAT[provider] ?? {});
		// Catalog defaults < current provider config < explicit modelOverrides (native composer).
		const compat = mergeCompat(
			mergeCompat(mergeCompat(defaults, model.compat ?? {}), facts?.compat ?? {}),
			configuredCompat,
		);
		const directPeak = provider === "deepseek" && ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(wireFor(provider).baseUrl.replace(/\/$/, ""))
            ? deepseekPeakCost(model.id) : undefined;
		return normalizeModelLimits({
			...model,
			...(directPeak ? { cost: directPeak } : {}),
			...facts,
			...(Object.keys(compat).length ? { compat } : {}),
		});
	});
}

const REFRESHERS: Record<string, Fetcher> = {
	openrouter: refreshOpenRouter,
	orcarouter: refreshOrcaRouter,
	together: refreshTogether,
	friendli: refreshFriendli,
	cerebras: refreshCerebras,
	deepseek: (ctx, _cached) =>
		refreshIdOnlyCatalog("deepseek", "https://api.deepseek.com/v1/models", ctx, ID_ONLY_FACTS.deepseek),
	runinfra: refreshRunInfra,
};

function refreshFor(
	providerId: string,
): NonNullable<ProviderConfig["refreshModels"]> {
	return async (context: RefreshModelContext): Promise<PiModel[]> => {
		const cache = loadCache();
		const cached = cache.providers[providerId];
		// One fallback owner for offline restore AND failed refreshes. Serving
		// stale data must never renew its six-hour freshness timestamp.
		const previousModels = () => {
			if (cached?.models) return publishModels(providerId, cached.models, cached.probes);
			if (providerId === "orcarouter")
				return publishModels(providerId, ORCA_FALLBACK_MODELS);
			return publishModels(providerId, [...storeModels(providerId).values(), ...(providerId === "deepseek" && ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(wireFor(providerId).baseUrl.replace(/\/$/, "")) ? [{...minimalModel("deepseek-flash", "deepseek", 384_000), ...DEEPSEEK_FLASH_FACTS}] : [])]);
		};
		if (context.allowNetwork === false || context.signal.aborted)
			return previousModels();
		const fresh =
			cached && Date.now() - cached.ts < ROUTER_CATALOG_TTL_MS && context.force !== true;
		if (fresh) return publishModels(providerId, cached.models, cached.probes);
		const startedAt = Date.now();
		try {
			const models = validModels(await REFRESHERS[providerId](context, cached));
			if (context.signal.aborted) return previousModels();
			if (models.length === 0)
				throw new Error(`${providerId} live catalog is empty`);
			const persisted = await saveCache(
				{
					ts: startedAt,
					models,
					rawCompat: true,
					...(cached?.probes ? { probes: cached.probes } : {}),
				},
				providerId,
				context.signal,
			).then(() => true, () => false);
			// Persistence is optional: valid responses still work this run. Probe
			// experiments require durable storage so their results cannot be wasted.
			if (context.signal.aborted) return previousModels();
			if (providerId === "together" && persisted) {
				const store = storeModels(providerId);
				scheduleTogetherProbes(
					models.filter((model) => !store.has(model.id)).map((model) => model.id),
					resolvedCatalogApiKey(providerId, context) ?? "",
					cached?.probes ?? {},
					context.signal,
				);
			}
			return publishModels(providerId, models, cached?.probes);
		} catch {
			// Retain the previous list on failure (never throw: pi-ai treats
			// a throwing refreshModels as "no models").
			return previousModels();
		}
	};
}

// ── Registration ───────────────────────────────────────────────────────

export default async function registerLiveModels(
	pi: ExtensionAPI,
): Promise<void> {
	const localProviderIds = registerLocalModels(pi, AGENT_DIR);
	for (const [providerId, meta] of [
		["openrouter", "OpenRouter"],
		["orcarouter", "OrcaRouter"],
		["together", "Together AI"],
		["friendli", "Friendli"],
		["cerebras", "Cerebras"],
		["deepseek", "DeepSeek"],
		["runinfra", "RunInfra"],
	] as const) {
		const wire = wireFor(providerId);
		pi.registerProvider(providerId, {
			name: meta,
			baseUrl: wire.baseUrl,
			api: wire.api,
			refreshModels: refreshFor(providerId),
		} satisfies ProviderConfig);
	}
	// Auto-fresh so new models appear without `pi update --models` or manual
	// work: every session start triggers a non-blocking network refresh scoped
	// to OUR providers (never the pi.dev builtins). Per-provider TTLs guard
	// the fetches, so frequent boots cost one cached list read, not I/O.
	let sessionGeneration = 0;
 let researchController = new AbortController();
	let lastRouterRefresh = 0;
	let routerRefreshPending = false;
	pi.on("session_start", (_event, ctx) => {
  researchController.abort(); researchController = new AbortController();
		const generation = ++sessionGeneration;
		lastRouterRefresh = Date.now();
		void ctx.modelRegistry
			.refresh({ allowNetwork: true, providers: [...REFRESHER_IDS, ...localProviderIds] })
			.then(() => { if (generation === sessionGeneration) { outputLimitStatus(ctx); void refreshModelResearch(ctx.modelRegistry.getAvailable().map(toModelInfo),researchController.signal); } })
			.catch(() => {});
		outputLimitStatus(ctx);
	});
	// Refresh discovery during long sessions without timers, inference probes,
	// or waiting on the next provider request. One bounded attempt per interval.
	pi.on("before_agent_start", (_event, ctx) => {
		const timestamp = Date.now();
		if (routerRefreshPending || timestamp - lastRouterRefresh < ROUTER_CATALOG_TTL_MS) return;
		lastRouterRefresh = timestamp;
		routerRefreshPending = true;
		const generation = sessionGeneration;
		void ctx.modelRegistry.refresh({allowNetwork: true, providers: [...REFRESHER_IDS]})
			.then(() => { if (generation === sessionGeneration) { outputLimitStatus(ctx); void refreshModelResearch(ctx.modelRegistry.getAvailable().map(toModelInfo),researchController.signal); } })
			.catch(() => {})
			.finally(() => { routerRefreshPending = false; });
	});
	pi.on("model_select", (_event, ctx) => outputLimitStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => { sessionGeneration++; researchController.abort(); if (ctx.hasUI) ctx.ui.setStatus("model-output-limit", undefined); });
}
